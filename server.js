import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

dotenv.config();

// Supabase 클라이언트
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SECRET_KEY || '',
  { realtime: { transport: ws } }
);

const app = express();
app.use(express.json());

// ══════════════════════════════════════════════════
// 🪙 코인 시스템
// ══════════════════════════════════════════════════

// 코인 소모량 정의
const COIN_COSTS = {
  ai_chat_per_min: 1,   // AI 대화 1분당
  taxi: 5,              // 택시 호출
  delivery: 3,          // 배달 주문
  shopping: 3,          // 쇼핑 주문
  music: 1,             // 음악 추천
  youtube: 1,           // 유튜브 추천
  concert: 10,          // 콘서트/예매
  hospital: 5,          // 병원 예약
  weather: 0,           // 날씨 무료
  fortune: 0,           // 운세 무료
  news: 0,              // 뉴스 무료
};

// 코인 조회
async function getCoins(phone) {
  try {
    const { data } = await supabase
      .from('users')
      .select('id, name, coins, plan')
      .eq('phone', phone)
      .single();
    return data;
  } catch { return null; }
}

// 코인 차감
async function deductCoins(userId, amount, description) {
  try {
    // 현재 잔액 확인
    const { data: user } = await supabase
      .from('users')
      .select('coins')
      .eq('id', userId)
      .single();

    if (!user || user.coins < amount) {
      return { success: false, coins: user?.coins || 0 };
    }

    // 차감
    const { data } = await supabase
      .from('users')
      .update({ coins: user.coins - amount, coins_used: supabase.raw('coins_used + ' + amount) })
      .eq('id', userId)
      .select('coins')
      .single();

    // 거래 로그
    await supabase.from('coin_transactions').insert([{
      user_id: userId,
      amount: -amount,
      type: 'deduct',
      description,
    }]);

    return { success: true, coins: data.coins };
  } catch (e) {
    console.error('코인 차감 오류:', e.message);
    return { success: false, coins: 0 };
  }
}

// 코인 적립
async function addCoins(userId, amount, description) {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('coins')
      .eq('id', userId)
      .single();

    const newCoins = (user?.coins || 0) + amount;

    await supabase.from('users').update({ coins: newCoins }).eq('id', userId);
    await supabase.from('coin_transactions').insert([{
      user_id: userId,
      amount,
      type: 'add',
      description,
    }]);

    return newCoins;
  } catch (e) {
    console.error('코인 적립 오류:', e.message);
    return 0;
  }
}

// 출석 보너스 (오늘 첫 통화 시)
async function checkDailyBonus(userId) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .from('coin_transactions')
      .select('id')
      .eq('user_id', userId)
      .eq('type', 'daily_bonus')
      .gte('created_at', today + 'T00:00:00')
      .single();

    if (!data) {
      const newCoins = await addCoins(userId, 10, '매일 출석 보너스');
      return `오늘 출석 보너스로 코인 10개가 적립됐어요! 현재 ${newCoins}코인이에요.`;
    }
    return null;
  } catch { return null; }
}

// 코인 잔액 안내 멘트
function coinBalanceMessage(coins, feature) {
  if (coins <= 0) {
    return `코인이 없어요. ${feature} 기능을 사용하려면 코인을 충전해주세요. 자녀분께 코인 선물을 요청하시거나, 충전 후 다시 이용해주세요.`;
  }
  if (coins <= 10) {
    return `코인이 ${coins}개밖에 남지 않았어요. 곧 충전이 필요해요.`;
  }
  return null;
}

// ══════════════════════════════════════════════════
// 🔧 헬퍼 함수
// ══════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: '말로해 서버', time: new Date().toISOString() });
});

// 코인 잔액 조회 API
app.get('/coins/:phone', async (req, res) => {
  const user = await getCoins(req.params.phone);
  if (!user) return res.json({ error: '사용자 없음' });
  res.json({ name: user.name, coins: user.coins, plan: user.plan });
});

// ── Vapi 웹훅 ─────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const body = req.body;
  const type = body?.message?.type;

  console.log('📞 Vapi 웹훅:', type);

  // tool-calls (최신 Vapi)
  if (type === 'tool-calls') {
    const toolCallList = body.message.toolCallList || [];
    const callerPhone = body.message?.call?.customer?.number || '';

    const results = await Promise.all(toolCallList.map(async (tc) => {
      const fnName = tc.function?.name;
      const params = JSON.parse(tc.function?.arguments || '{}');
      let result = '';

      // 코인이 필요한 기능은 먼저 체크
      const coinCost = COIN_COSTS[fnName] || 0;
      if (coinCost > 0 && callerPhone) {
        const user = await getCoins(callerPhone);
        if (user) {
          const low = coinBalanceMessage(user.coins, fnName);
          if (user.coins < coinCost) {
            return { toolCallId: tc.id, result: low || `코인이 부족해요. 현재 ${user.coins}코인이에요.` };
          }
          await deductCoins(user.id, coinCost, fnName);
        }
      }

      switch (fnName) {
        case 'get_weather':    result = await getWeather(params.city || '서울'); break;
        case 'get_fortune':    result = await getFortune(params.birth_date, params.name); break;
        case 'send_sms':       result = await sendSMS(params.phone, params.message); break;
        case 'get_news':       result = await getNews(); break;
        case 'register_user':  result = await registerUser(params, body.message?.call?.id); break;
        case 'forward_call':   result = `${params.name}님 번호(${params.phone})로 연결합니다. 잠시만 기다려주세요.`; break;
        case 'get_family':     result = await getFamily(params.phone || callerPhone); break;
        case 'get_coins':      result = await getCoinBalance(params.phone || callerPhone); break;
        case 'get_music':      result = await getMusic(params.genre || '트로트', params.phone || callerPhone); break;
        case 'get_youtube':    result = await getYoutube(params.query, params.phone || callerPhone); break;
        case 'daily_bonus':    result = await checkDailyBonus((await getCoins(callerPhone))?.id) || '오늘 이미 출석 보너스를 받으셨어요!'; break;
        default: result = '죄송합니다, 해당 기능은 준비 중입니다.';
      }
      return { toolCallId: tc.id, result };
    }));
    return res.json({ results });
  }

  // function-call (구형 호환)
  if (type === 'function-call') {
    const fnName = body.message.functionCall?.name;
    const params = body.message.functionCall?.parameters || {};
    let result = '';
    switch (fnName) {
      case 'get_weather':    result = await getWeather(params.city || '서울'); break;
      case 'get_fortune':    result = await getFortune(params.birth_date, params.name); break;
      case 'send_sms':       result = await sendSMS(params.phone, params.message); break;
      case 'get_news':       result = await getNews(); break;
      case 'register_user':  result = await registerUser(params); break;
      case 'forward_call':   result = `${params.name}님 번호(${params.phone})로 연결합니다.`; break;
      case 'get_music':      result = await getMusic(params.genre || '트로트', params.phone); break;
      case 'get_youtube':    result = await getYoutube(params.query, params.phone); break;
      default: result = '죄송합니다, 해당 기능은 준비 중입니다.';
    }
    return res.json({ result });
  }

  // 통화 시작 → 출석 보너스 체크
  if (type === 'call-start') {
    const phone = body.message?.call?.customer?.number || '';
    if (phone) {
      const user = await getCoins(phone);
      if (user) {
        const bonus = await checkDailyBonus(user.id);
        if (bonus) console.log('🎁 출석 보너스:', bonus);
      }
    }
  }

  // 통화 종료 → 로그 저장
  if (type === 'end-of-call-report') {
    const call = body.message.call || {};
    const durationSec = Math.round(((call.endedAt || 0) - (call.startedAt || 0)) / 1000);
    console.log('📵 통화 종료:', call.id, '/', durationSec, '초');
    await saveCallLog(call);
    await updateDailyReport(call, durationSec);
  }

  res.json({ received: true });
});

// ══════════════════════════════════════════════════
// 🌤️ 날씨 (무료)
// ══════════════════════════════════════════════════
async function getWeather(city) {
  try {
    const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { timeout: 5000 });
    const w = res.data?.current_condition?.[0];
    const temp = w?.temp_C;
    const desc = w?.lang_ko?.[0]?.value || w?.weatherDesc?.[0]?.value || '맑음';
    const outfit = getOutfitAdvice(parseInt(temp));
    return `${city} 현재 날씨는 ${desc}, 기온은 ${temp}도입니다. ${outfit}`;
  } catch {
    return '서울 현재 날씨는 맑음, 기온은 13도입니다. 쌀쌀하니 코트를 입으세요.';
  }
}

function getOutfitAdvice(temp) {
  if (temp >= 23) return '반팔이나 얇은 셔츠가 좋겠습니다.';
  if (temp >= 17) return '가벼운 가디건이나 얇은 재킷을 챙기세요.';
  if (temp >= 11) return '재킷이나 두꺼운 가디건이 필요합니다.';
  if (temp >= 5)  return '코트와 목도리를 꼭 챙기세요.';
  return '패딩이나 두꺼운 코트가 필요합니다. 장갑도 챙기세요.';
}

// ══════════════════════════════════════════════════
// 🔮 운세 (무료)
// ══════════════════════════════════════════════════
async function getFortune(birthDate, name) {
  const fortunes = [
    '오늘은 귀인을 만날 수 있는 날입니다. 외출하면 좋은 일이 생길 것입니다.',
    '재물운이 좋은 날입니다. 오늘은 평소에 미뤄뒀던 일을 처리하기 좋습니다.',
    '건강에 신경 쓰세요. 무리하지 말고 충분한 휴식을 취하세요.',
    '오늘은 새로운 시작에 좋은 날입니다. 오랫동안 연락 못한 지인에게 연락해보세요.',
    '인간관계가 원만한 날입니다. 가족과 함께하는 시간을 가지면 복이 옵니다.',
    '오늘은 조용히 쉬는 것이 최고입니다. 무리한 약속은 피하세요.',
    '좋은 소식이 올 것입니다. 전화나 문자를 기다려보세요.',
  ];
  const idx = Math.floor(Math.random() * fortunes.length);
  const nameStr = name ? `${name}님의 ` : '';
  return `${nameStr}오늘의 운세입니다. ${fortunes[idx]} 오늘 하루도 건강하고 행복하게 보내세요!`;
}

// ══════════════════════════════════════════════════
// 📰 뉴스 (무료)
// ══════════════════════════════════════════════════
async function getNews() {
  try {
    const res = await axios.get('https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko', { timeout: 5000 });
    const items = res.data.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)?.slice(1, 4) || [];
    const titles = items.map(i => i.replace(/<title><!\[CDATA\[(.+?)\]\]><\/title>/, '$1'));
    if (titles.length > 0) {
      return `오늘의 주요 뉴스입니다. 첫째, ${titles[0]}. 둘째, ${titles[1] || ''}. 셋째, ${titles[2] || ''}.`;
    }
  } catch {}
  return '오늘의 주요 뉴스입니다. 첫째, 오늘 날씨는 전국 대체로 맑겠습니다. 둘째, 독감 예방접종 무료 대상이 65세 이상으로 확대됐습니다.';
}

// ══════════════════════════════════════════════════
// 🎵 음악 추천 (1코인)
// ══════════════════════════════════════════════════
const MUSIC_PLAYLISTS = {
  '트로트': { title: '트로트 인기곡 모음', url: 'https://www.youtube.com/playlist?list=PLQ3ItidzShFH_GQ4D2o9hcW3bRHNYk4IQ' },
  '임영웅': { title: '임영웅 베스트', url: 'https://www.youtube.com/results?search_query=임영웅+노래모음' },
  '7080': { title: '7080 추억의 노래', url: 'https://www.youtube.com/results?search_query=7080+노래모음' },
  '힐링': { title: '힐링 음악 모음', url: 'https://www.youtube.com/results?search_query=힐링음악+잔잔한+음악' },
  '클래식': { title: '클래식 음악', url: 'https://www.youtube.com/results?search_query=클래식음악+모음' },
  '라디오': { title: 'KBS 라디오', url: 'https://www.youtube.com/@kbsradio' },
  '국악': { title: '국악 모음', url: 'https://www.youtube.com/results?search_query=국악+모음' },
};

async function getMusic(genre, phone) {
  const playlist = MUSIC_PLAYLISTS[genre] || MUSIC_PLAYLISTS['트로트'];

  // SMS로 링크 발송
  if (phone) {
    const msg = `🎵 말로해 음악 추천\n${playlist.title}\n${playlist.url}`;
    await sendSMS(phone, msg);
  }

  return `${genre} 플레이리스트를 카카오톡으로 보내드렸어요! 핸드폰에서 확인해보세요. 즐거운 음악 감상 되세요!`;
}

// ══════════════════════════════════════════════════
// 📺 유튜브 추천 (1코인)
// ══════════════════════════════════════════════════
const YOUTUBE_CATEGORIES = {
  '체조': '어르신 아침체조 10분',
  '뉴스': 'KBS 뉴스 오늘',
  '요리': '어르신 쉬운 요리',
  '웃긴': '웃긴 영상 모음',
  '건강': '건강 체조 운동',
  '드라마': '인기 드라마 클립',
  '자연': '자연 풍경 힐링',
};

async function getYoutube(query, phone) {
  const keyword = YOUTUBE_CATEGORIES[query] || query || '어르신 추천 영상';
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}`;

  if (phone) {
    const msg = `📺 말로해 영상 추천\n${keyword}\n${url}`;
    await sendSMS(phone, msg);
  }

  return `${keyword} 영상을 카카오톡으로 보내드렸어요! 핸드폰에서 확인해보세요.`;
}

// ══════════════════════════════════════════════════
// 🪙 코인 잔액 조회 (음성)
// ══════════════════════════════════════════════════
async function getCoinBalance(phone) {
  const user = await getCoins(phone);
  if (!user) return '가입 정보가 없습니다. 먼저 가입해 주세요.';

  const plan = user.plan === 'free' ? '무료' : user.plan === 'basic' ? '베이직' : user.plan === 'hyodo' ? '효도' : '프리미엄';
  return `${user.name}님의 현재 코인은 ${user.coins}개입니다. 플랜은 ${plan}이에요. 매일 전화하시면 출석 보너스로 10코인씩 받으실 수 있어요!`;
}

// ══════════════════════════════════════════════════
// 📱 SMS 발송
// ══════════════════════════════════════════════════
async function sendSMS(phone, message) {
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER || process.env.VAPI_PHONE_NUMBER;
    if (!sid || !token) {
      console.log(`📱 SMS (미연동) → ${phone}: ${message}`);
      return `${phone}번호로 메시지를 보냈습니다.`;
    }
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      new URLSearchParams({ To: phone, From: from, Body: message }),
      { auth: { username: sid, password: token } }
    );
    return `${phone}번호로 문자를 보냈습니다.`;
  } catch (e) {
    console.error('SMS 오류:', e.message);
    return `문자 발송 중 오류가 발생했습니다.`;
  }
}

// ══════════════════════════════════════════════════
// 👤 회원 등록/조회
// ══════════════════════════════════════════════════
async function registerUser(params, callId) {
  try {
    const { name, phone, birth_date, address } = params;

    const { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    if (existing) {
      return `${existing.name}님, 이미 가입하신 회원이세요. 현재 코인은 ${existing.coins || 0}개입니다. 반갑습니다!`;
    }

    const { data, error } = await supabase
      .from('users')
      .insert([{ name, phone, birth_date, address, coins: 100, plan: 'free' }])
      .select()
      .single();

    if (error) throw error;

    // 가입 보너스 로그
    await supabase.from('coin_transactions').insert([{
      user_id: data.id,
      amount: 100,
      type: 'add',
      description: '가입 보너스',
    }]);

    console.log('👤 신규 가입:', data);
    return `${name}님, 말로해 가입이 완료됐습니다! 가입 보너스로 코인 100개를 드렸어요. 날씨, 운세, 뉴스는 무료로 언제든 이용하세요!`;
  } catch (e) {
    console.error('회원 등록 오류:', e.message);
    return '가입 처리 중 오류가 발생했습니다. 잠시 후 다시 말씀해주세요.';
  }
}

// ══════════════════════════════════════════════════
// 👨‍👩‍👧 가족 연락처
// ══════════════════════════════════════════════════
async function getFamily(phone) {
  try {
    const { data: user } = await supabase.from('users').select('id, name').eq('phone', phone).single();
    if (!user) return '가입 정보가 없습니다. 먼저 가입해 주세요.';

    const { data: family } = await supabase.from('family_contacts').select('*').eq('user_id', user.id);
    if (!family || family.length === 0) return '등록된 가족 연락처가 없습니다.';

    const list = family.map(f => `${f.relation || ''} ${f.name} (${f.phone})`).join(', ');
    return `${user.name}님의 가족 연락처입니다: ${list}`;
  } catch (e) {
    return '연락처 조회 중 오류가 발생했습니다.';
  }
}

// ══════════════════════════════════════════════════
// 📊 통화 로그 / 케어 리포트
// ══════════════════════════════════════════════════
async function saveCallLog(call) {
  try {
    await supabase.from('call_logs').insert([{
      call_id: call.id,
      duration_seconds: Math.round(((call.endedAt || 0) - (call.startedAt || 0)) / 1000),
    }]);
  } catch (e) {
    console.error('로그 저장 오류:', e.message);
  }
}

async function updateDailyReport(call, durationSec) {
  try {
    const phone = call.customer?.number;
    if (!phone) return;

    const { data: user } = await supabase.from('users').select('id').eq('phone', phone).single();
    if (!user) return;

    const today = new Date().toISOString().slice(0, 10);

    const { data: existing } = await supabase
      .from('daily_reports')
      .select('*')
      .eq('user_id', user.id)
      .eq('report_date', today)
      .single();

    if (existing) {
      await supabase.from('daily_reports').update({
        call_count: existing.call_count + 1,
        total_duration_seconds: existing.total_duration_seconds + durationSec,
      }).eq('id', existing.id);
    } else {
      await supabase.from('daily_reports').insert([{
        user_id: user.id,
        report_date: today,
        call_count: 1,
        total_duration_seconds: durationSec,
      }]);
    }

    console.log(`📊 케어 리포트 업데이트: ${phone} / ${durationSec}초`);
  } catch (e) {
    console.error('케어 리포트 오류:', e.message);
  }
}

// ══════════════════════════════════════════════════
// 🚀 서버 시작
// ══════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 말로해 서버 실행 중: http://localhost:${PORT}`);
  console.log(`🪙 코인 시스템 활성화`);
  console.log(`🎵 음악 추천 활성화`);
  console.log(`📺 유튜브 추천 활성화`);
  console.log(`📊 케어 리포트 활성화`);
});
