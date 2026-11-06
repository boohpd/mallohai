# 말로해 (Mallohai) — 어르신·시각장애인 AI 전화 생활도우미

## 서비스 소개
전화 한 통으로 AI가 날씨, 운세, 뉴스를 알려주고 가족에게 문자를 보내주는 서비스

## 기술 스택
- **AI 전화**: Vapi.ai (GPT-4o + Azure ko-KR-SunHiNeural)
- **서버**: Node.js + Express (Render 배포)
- **DB**: Supabase (PostgreSQL)
- **SMS**: Twilio (예정)

## 환경변수 (.env)
```
VAPI_API_KEY=
VAPI_ASSISTANT_ID=
SUPABASE_URL=
SUPABASE_SECRET_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
PORT=3000
```

## DB 세팅
Supabase SQL Editor에서 `supabase_schema.sql` 실행

## 실행
```bash
npm install
npm start
```
