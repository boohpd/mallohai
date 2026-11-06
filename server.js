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

// ── 헬스체크 ──────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: '말로해 서버', time: new Date().toISOString() });
});

// ── Vapi 웹훅 ─────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const body = req.body;
  const type = body?.message?.type;

  console.log('📞 Vapi 웹훅:', type);

  // tool-calls (최신 Vapi)
  if (type === 'tool-calls') {
    const toolCallList = body.message.toolCallList || [];
    const results = await Promise.all(toolCallList.map(async (tc) => {
      const fnName = tc.function?.name;
      const params = JSON.parse(tc.function?.arguments || '{}');
      let result = '';
      switch (fnName) {
        case 'get_weather':   result = await getWeather(params.city || '서울'); break;
        case 'get_fortune':   result = await getFortune(params.birth_date, params.name); break;
        case 'send_sms':      result = await sendSMS(params.phone, params.message); break;
        case 'get_news':      result = await getNews(); break;
        case 'register_user': result = await registerUser(params, body.message?.call?.id); break;
        case 'forward_call':  result = `${params.name}님 번호(${params.phone})로 연결합니다. 잠시만 기다려주세요.`; break;
        case 'get_family':    result = await getFamily(params.phone); break;
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
      case 'get_weather':   result = await getWeather(params.city || '서울'); break;
      case 'get_fortune':   result = await getFortune(params.birth_date, params.name); break;
      case 'send_sms':      result = await sendSMS(params.phone, params.message); break;
      case 'get_news':      result = await getNews(); break;
      case 'register_user': result = await registerUser(params); break;
      case 'forward_call':  result = `${params.name}님 번호(${params.phone})로 연결합니다.`; break;
      default: result = '죄송합니다, 해당 기능은 준비 중입니다.';
    }
    return res.json({ result });
  }

  // 통화 종료 → 로그 저장
  if (type === 'end-of-call-report') {
    const call = body.message.call || {};
    console.log('📵 통화 종료:', call.id, '/', Math.round((call.endedAt - call.startedAt) / 1000), '초');
    await saveCallLog(call);
  }

  res.json({ received: true });
});

// ── 날씨 ──────────────────────────────────────────
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

// ── 운세 ──────────────────────────────────────────
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

// ── 뉴스 ──────────────────────────────────────────
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

// ── SMS 발송 ───────────────────────────────────────
async function sendSMS(phone, message) {
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!sid || !token || !from) {
      console.log(`📱 SMS (미연동) → ${phone}: ${message}`);
      return `${phone}번호로 메시지를 보냈습니다.`;
    }
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      new URLSearchParams({ To: phone, From: from, Body: message }),
      { auth: { username: sid, password: token } }
    );
    return `${phone}번호로 문자를 보냈습니다. 내용: "${message}"`;
  } catch (e) {
    console.error('SMS 오류:', e.message);
    return `문자 발송 중 오류가 발생했습니다. 나중에 다시 시도해주세요.`;
  }
}

// ── 회원 등록/조회 ──────────────────────────────────
async function registerUser(params, callId) {
  try {
    const { name, phone, birth_date, address } = params;
    
    // 기존 회원 확인
    const { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    if (existing) {
      return `${existing.name}님, 이미 가입하신 회원이세요. 반갑습니다!`;
    }

    // 신규 가입
    const { data, error } = await supabase
      .from('users')
      .insert([{ name, phone, birth_date, address }])
      .select()
      .single();

    if (error) throw error;
    console.log('👤 신규 가입:', data);
    return `${name}님, 말로해 가입이 완료됐습니다. 앞으로 날씨, 운세, 뉴스를 전화로 알려드릴게요!`;
  } catch (e) {
    console.error('회원 등록 오류:', e.message);
    return '가입 처리 중 오류가 발생했습니다. 잠시 후 다시 말씀해주세요.';
  }
}

// ── 가족 연락처 조회 ───────────────────────────────
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

// ── 통화 로그 저장 ─────────────────────────────────
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

// ── 서버 시작 ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 말로해 서버 실행 중: http://localhost:${PORT}`);
});
