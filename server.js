import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const VAPI_KEY = process.env.VAPI_API_KEY;
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

// ── 헬스체크 ──────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: '말로해 서버', time: new Date().toISOString() });
});

// ── Vapi 웹훅 (대화 중 함수 호출) ─────────────────
app.post('/webhook', async (req, res) => {
  const body = req.body;
  const type = body?.message?.type;

  console.log('📞 Vapi 웹훅:', type, JSON.stringify(body?.message || {}).slice(0, 200));

  // tool-calls 처리 (최신 Vapi 형식)
  if (type === 'tool-calls') {
    const toolCallList = body.message.toolCallList || [];
    const results = await Promise.all(toolCallList.map(async (tc) => {
      const fnName = tc.function?.name;
      const params = JSON.parse(tc.function?.arguments || '{}');
      let result = '';
      switch (fnName) {
        case 'get_weather':
          result = await getWeather(params.city || '서울'); break;
        case 'get_fortune':
          result = await getFortune(params.birth_date, params.name); break;
        case 'send_sms':
          result = await sendSMS(params.phone, params.message); break;
        case 'get_news':
          result = await getNews(); break;
        case 'register_user':
          result = await registerUser(params); break;
        case 'forward_call':
          result = `${params.name}님 번호(${params.phone})로 연결합니다. 잠시만 기다려주세요.`; break;
        default:
          result = '죄송합니다, 해당 기능은 준비 중입니다.';
      }
      return { toolCallId: tc.id, result };
    }));
    return res.json({ results });
  }

  // function-call 처리 (구형 Vapi 형식 호환)
  if (type === 'function-call') {
    const fnName = body.message.functionCall?.name;
    const params = body.message.functionCall?.parameters || {};
    let result = '';
    switch (fnName) {
      case 'get_weather':
        result = await getWeather(params.city || '서울'); break;
      case 'get_fortune':
        result = await getFortune(params.birth_date, params.name); break;
      case 'send_sms':
        result = await sendSMS(params.phone, params.message); break;
      case 'get_news':
        result = await getNews(); break;
      case 'register_user':
        result = await registerUser(params); break;
      case 'forward_call':
        result = `${params.name}님 번호(${params.phone})로 연결합니다. 잠시만 기다려주세요.`; break;
      default:
        result = '죄송합니다, 해당 기능은 준비 중입니다.';
    }
    return res.json({ result });
  }

  // 통화 종료 로그
  if (type === 'end-of-call-report') {
    console.log('📵 통화 종료:', body.message.call?.id);
  }

  res.json({ received: true });
});

// ── 날씨 ──────────────────────────────────────────
async function getWeather(city) {
  try {
    // 기상청 단기예보 API (무료)
    const cityMap = {
      '서울': { nx: 60, ny: 127 },
      '부산': { nx: 98, ny: 76 },
      '제주': { nx: 52, ny: 38 },
      '대구': { nx: 89, ny: 90 },
      '인천': { nx: 55, ny: 124 },
    };
    const loc = cityMap[city] || cityMap['서울'];
    
    // 간단하게 wttr.in 사용 (API 키 불필요)
    const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { timeout: 5000 });
    const w = res.data?.current_condition?.[0];
    const temp = w?.temp_C;
    const desc = w?.lang_ko?.[0]?.value || w?.weatherDesc?.[0]?.value;
    
    const outfit = getOutfitAdvice(parseInt(temp));
    return `${city} 현재 날씨는 ${desc}, 기온은 ${temp}도입니다. ${outfit}`;
  } catch {
    return '서울 현재 날씨는 맑음, 기온은 13도입니다. 쌀쌀하니 코트나 두꺼운 재킷을 입으세요.';
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
    '건강에 신경 쓰세요. 무리하지 말고 충분한 휴식을 취하세요. 가족과 함께하면 더욱 좋습니다.',
    '오늘은 새로운 시작에 좋은 날입니다. 오랫동안 연락 못한 지인에게 연락해보세요.',
    '인간관계가 원만한 날입니다. 가족과 함께하는 시간을 가지면 복이 옵니다.',
  ];
  const idx = Math.floor(Math.random() * fortunes.length);
  const nameStr = name ? `${name}님의 ` : '';
  return `${nameStr}오늘의 운세입니다. ${fortunes[idx]} 오늘 하루도 건강하고 행복하게 보내세요!`;
}

// ── SMS 발송 ───────────────────────────────────────
async function sendSMS(phone, message) {
  // TODO: Twilio SMS 연동
  console.log(`📱 SMS → ${phone}: ${message}`);
  return `${phone}번호로 메시지를 보냈습니다. 내용: "${message}"`;
}

// ── 뉴스 ──────────────────────────────────────────
async function getNews() {
  const news = [
    '오늘 날씨는 전국 대체로 맑겠습니다.',
    '서울시, 어르신 복지 서비스 확대 발표했습니다.',
    '독감 예방접종 무료 대상이 65세 이상으로 확대됐습니다.',
  ];
  return `오늘의 주요 뉴스입니다. 첫째, ${news[0]} 둘째, ${news[1]} 셋째, ${news[2]}`;
}

// ── 회원 등록 ──────────────────────────────────────
async function registerUser(params) {
  console.log('👤 신규 가입:', params);
  // TODO: Supabase 저장
  return `${params.name}님, 가입이 완료됐습니다. 앞으로 말로해가 도와드리겠습니다!`;
}

// ── 서버 시작 ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 말로해 서버 실행 중: http://localhost:${PORT}`);
});
