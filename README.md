# Notepad AI

애플 실리콘 Mac을 위한, **한국어 사용자 중심의 오픈소스 마크다운 편집기.** Obsidian이 어렵게 느껴지는 분들을 위해, 쉬운 편집기에 실용적인 AI 글쓰기 도우미를 더했습니다.

> 공개 오픈소스 프로젝트입니다. 코드 서명이 없는 v1 빌드이므로 첫 실행 시 Gatekeeper 우회가 한 번 필요합니다(아래 설치 안내 참고).

## 주요 특징

- 🇰🇷 **한국어 우선** — 모든 AI 출력이 기본으로 자연스러운 한국어로 나옵니다(“AI 티” 제거). UI는 한·영·중(간/번)·일 5개 언어.
- 🔒 **내 컴퓨터에서 도는 무료 AI** — Ollama·LM Studio를 자동 감지해 로컬 모델로 채팅/첨삭/HTML 생성. 인터넷·구독·API 키 없이도 동작하고, 문서가 외부로 나가지 않습니다.
- 💬 **AI 글쓰기 컨설턴트** — 작성·상담·프로젝트 설정·HTML 생성을 한 패널의 4개 탭으로. 상담은 현재 문서를 자동 동기화하고, 이미지를 붙이면 비전 모델은 직접 읽고 그 외 모델은 **오프라인 OCR(한국어+영어)**로 처리합니다.
- 🎨 **AI가 문서를 인터랙티브 웹페이지로** — 마크다운을 한 번에 스타일 입힌 HTML 문서나 슬라이드로 내보냅니다. 결과에는 테마 전환과 슬라이드 조작을 더할 수 있으며, 성공적으로 처리한 응답의 위험 요소만 자동 정리하고 응답이 비어 있거나 해석할 수 없으면 명확한 오류를 표시합니다.
- ↔️ **정렬되는 좌우 분할** — RAW 편집기와 리치 프리뷰의 같은 블록이 줄 단위로 정렬되고 스크롤이 함께 움직입니다.
- 📁 **사이드 파일 탐색기** — 작업 폴더를 트리로 열어 문서 사이를 빠르게 오갑니다.
- 🔐 **프라이버시 우선** — API 키는 Keychain 암호화 저장(평문 디스크 기록 없음), 외부 통신은 허용 목록 기반, 원본 마크다운은 항상 진실(source of truth).
## 무엇이 새로워졌나요
- **v0.9.0** — HTML 내보내기에 테마 전환, 슬라이드 조작, 인터랙티브 요소와 인쇄 지원을 더했습니다. 자세한 변경 사항은 [CHANGELOG](./CHANGELOG.md)에서 확인하세요.


## 설치

1. [Releases](https://github.com/project820/notepad-ai/releases)에서 `Notepad.AI-<version>-arm64.dmg`를 내려받아 엽니다.
2. `Notepad AI`를 `Applications`로 드래그합니다.
3. **첫 실행(미서명 앱):** Finder에서 `/Applications`의 앱을 **Control-클릭(또는 우클릭) → 열기**로 실행한 뒤, 경고창에서 다시 **열기**를 누릅니다. 이 절차는 해당 앱의 Gatekeeper 예외를 저장합니다. 일반 더블클릭으로는 첫 실행 예외가 만들어지지 않습니다. 계속 막히면 시스템 설정 **개인정보 보호 및 보안**에서 열기를 허용하거나 터미널에서:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Notepad AI.app"
   ```
4. 자세한 화면 안내는 저장소의 `install-guide.html`를 브라우저로 열어 볼 수 있습니다.

> **Apple Silicon 전용**입니다(Intel Mac 미지원).

## 기능

### 편집기
- CodeMirror 6 + 실시간 리치 프리뷰(markdown-it, GFM, 체크박스)
- 프리뷰에서 직접 편집(contenteditable) → MD 동기화
- 툴바: 굵게 / 이탤릭 / 취소선 / 인라인 코드 / H1~H3 / 인용 / 목록 / 체크리스트 / 링크 / 코드블록 / 수평선
- **표 편집(재설계):** Excel식으로 셀을 고르고 그 셀 기준 좌/우 열·상/하 행을 추가합니다. MD가 항상 진실(source of truth)이며, 프리뷰 표 편집이 원본 MD를 깨뜨리지 않습니다. 데이터가 있는 행/열은 삭제 전 확인을 받습니다.
- 보기 전환: 좌우 분할 / 리치 전용 / RAW 전용
- **정렬되는 좌우 분할** — RAW 편집기와 리치 프리뷰에서 같은 블록의 줄 높이를 맞추고(display-only 스페이서, 원본 MD 불변) 두 창의 스크롤을 함께 동기화합니다.
- **사이드 패널** — 개요/각주 탭과 파일 탐색기 탭. 작업 폴더를 트리로 열고 필터링하며 문서를 빠르게 전환합니다.
- 멀티 윈도우 · 세션 복원(크래시/재시작 후 열려 있던 문서 복구) · 새 버전 알림(인앱 업데이트 확인)

### 파일 가져오기
- HWP · HWPX · DOCX · PDF · XLSX → Markdown 자동 변환(`kordoc`)

### AI 기능
- **AI 컨설턴트(통합 채팅)** — **작성 · 상담 · 프로젝트 설정 · HTML 생성** 4개 탭을 한 패널에서. 작성은 결과를 문서에 바로 삽입/교체하고, 상담은 현재 문서를 자동으로 동기화해 맥락에 맞춰 답합니다(필요하면 수동 동기화). 상단 빨간 **“Ai”** 버튼으로 엽니다.
- **프로젝트 설정 마법사** — 작업 폴더에 대한 `Overview.md` 개요 초안을 몇 가지 질문으로 만들어 줍니다. 초안을 **승인하기 전까지는 아무것도 저장되지 않습니다.**
- **이미지 첨부 + 오프라인 OCR** — 채팅에 이미지를 붙여넣거나 첨부할 수 있습니다. 비전 지원 모델은 이미지를 직접 읽고, 그 외/로컬 모델은 **기기에 내장된 OCR(한국어+영어, 인터넷 불필요)**로 글자를 추출해 전달합니다.
- **블록 AI** — 선택한 텍스트를 그 자리에서 첨삭/대안 제시.
- **AI HTML 내보내기(고도화)** — 문서를 한 번에 스타일 입힌 HTML 페이지나 슬라이드로 변환합니다. **자동/디테일** 모드에서 용도·표현 스타일·방향·밀도·디자인 소스를 고르고, 모델 선택은 재시도에도 유지됩니다. 결과에는 테마 전환(☀/🌙)과 슬라이드 키보드·버튼·진행 표시 조작이 포함되며, 인터랙티브 체크박스 같은 자체 완결형 요소도 사용할 수 있습니다. 네트워크 요청은 내보낸 문서의 CSP로 차단됩니다. 성공적으로 처리한 응답의 위험 요소만 자동 정리하고 응답이 비어 있거나 해석할 수 없으면 명확한 오류를 표시합니다.
- **문체 설정** — **이해 수준**(초등~전문가)과 자연스러움(윤문 강도)을 하나의 설정으로 조절합니다.
- **항상 켜진 윤문(한글 AI 티 제거)** — 모든 AI 출력이 기본으로 자연스러운 한국어로 나옵니다. 코드·인용·수치·고유명사 등 사실은 보존합니다. (영어 윤문은 최소 기능의 **실험적(Experimental)** 단계입니다.)
- 메인 채팅 · 블록 AI · HTML 내보내기마다 **모델을 따로** 고를 수 있습니다.

### AI 모델 설정(다중 프로바이더)
사용할 AI를 직접 고릅니다. v1에서 지원하는 연결 방식:

| 프로바이더 | 연결 방식 |
|-----------|-----------|
| ChatGPT | 구독 로그인(device-code OAuth) |
| Claude (Anthropic) | 로컬 `claude` CLI 우선(구독·무과금) + Anthropic API 키 폴백 |
| Grok | 로컬 `grok` CLI(구독·무과금) — API 키 불필요 |
| OpenRouter | API 키 (Gemini·Grok 등 여러 모델 접근) |
| Ollama | 로컬 서버 자동 감지(기본 `:11434`) — 키·인터넷 불필요 |
| LM Studio | 로컬 서버 자동 감지(기본 `:1234`) — 키·인터넷 불필요 |

- **로컬 모델(Ollama / LM Studio)** — 서버를 켜두면 설치된 모델을 자동으로 찾아 세 곳(메인 채팅·블록 AI·HTML 내보내기) 모두에서 쓸 수 있습니다. 설정에서 서버 주소를 바꿀 수 있고, 로컬 탐지는 클라우드 모델 목록을 절대 막지 않습니다(비차단). 문서가 기기 밖으로 나가지 않습니다.
- 내장 **모델 카탈로그**에서 프로바이더와 모델을 고르며, 카탈로그에 없는 모델은 **커스텀 모델 ID**로 직접 입력할 수 있습니다.
- **HTML 내보내기 모델** — 검증된 ChatGPT(GPT-5.6 Sol·Terra·Luna), Claude, Grok 및 자동 감지한 로컬 모델을 선택할 수 있습니다. GPT-5.6 모델에는 Fast 옵션이 표시됩니다.
- 아무 프로바이더도 연결하지 않으면 AI 기능은 잠기고, 연결을 안내합니다.
- API 키는 macOS Keychain(`safeStorage`)으로 암호화 저장하며, 암호화를 쓸 수 없는 환경에서는 **디스크에 저장하지 않고** 해당 세션 메모리에만 둡니다. 키는 화면에 끝 4자리만 표시됩니다.
- **구독형 로컬 CLI 프로바이더(v0.7)** — Claude/Grok 모델을 고르면 유료 API 대신 **로컬 구독 CLI**(`claude -p`, `grok`)로 먼저 호출해 과금을 최소화합니다. 프롬프트는 argv가 아닌 stdin/임시파일로 전달하고, 외부 CLI에는 최소 환경변수만 넘겨 다른 프로바이더의 API 키가 새지 않게 합니다. `claude`는 CLI가 없으면 Anthropic API로 자동 폴백하고, `grok`은 CLI 전용이라 미설치 시 설치/로그인 안내를 표시합니다(유료 폴백 없음). 에이전트 모드 채팅·Antigravity는 후속 과제입니다.
- **Gemini 네이티브 구독 로그인**은 후속 과제입니다(현재는 OpenRouter로 접근).

## 개발

이 프로젝트는 Node.js >= 22.12.0와 Electron 43 / electron-builder 26을 사용합니다. 일반 개발
빌드는 빠른 반복을 위해 OCR 패키징 검사 없이 실행하며, DMG·로컬 설치·CI에서는
`tessdata` 사전 검사를 먼저 실행합니다.

```bash
npm install
npm run dev                # Electron + Vite HMR 개발 모드
npm run typecheck          # 타입 검사 (main + renderer)
npm run test               # 단위 테스트 (vitest)
npm run build              # main + renderer 빌드 (패키징 전 검사 제외)
npm run preflight:tessdata # 오프라인 OCR 언어 데이터 검사
npm run install:local      # ⭐ 검사 → 빌드 → /Applications에 1개만 설치 → release 정리
npm run build:dmg          # 검사 → 빌드 → 배포용 DMG 생성 → release/
```

전체 CI/PR 검증 게이트 목록은 [CONTRIBUTING.md](./CONTRIBUTING.md#pr-verification-checklist)를 따릅니다.

### 단일 앱 원칙 (중요 — 앱을 여러 개 만들지 말 것)

로컬에서 앱을 설치/갱신할 때는 **반드시 `npm run install:local` 하나만** 사용한다. 이 스크립트는 빌드 후 `/Applications/Notepad AI.app` **하나만** 설치하고 빌드 스테이징(`release/`)을 자동 삭제하므로, 시스템에 **항상 정확히 1개의 Notepad AI 앱**만 남는다.

- `release/`·`dist/`는 빌드 산출물이며 **앱이 아니다**. `release/mac-arm64/Notepad AI.app`가 남아 있으면 Spotlight/Launchpad가 이를 **두 번째 앱**으로 인식한다 — 절대 방치하지 말 것(`.gitignore`에 이미 제외됨).
- 앱은 **단일 인스턴스 락**(`app.requestSingleInstanceLock`, `src/main/main.ts`)을 강제하므로 두 번 실행해도 새 인스턴스가 뜨지 않고 기존 창이 앞으로 온다.
- 정리 명령: 떠도는 빌드 번들 제거 → `rm -rf release dist` 후 `npm run install:local` 재실행.

## 구조

```
src/
  main/
    main.ts            BrowserWindow, 메뉴, 파일 IO, IPC
    preload.ts         contextBridge (window.api)
    ai/                다중 프로바이더 레지스트리 (chatgpt/claude/openrouter + ollama/lmstudio 로컬), 모델 카탈로그, API 키 저장, 로컬 모델 캐시
    codex-auth.ts      OpenAI device-code OAuth + safeStorage
    session-store.ts   충돌 복구 스냅샷
  renderer/
    editor.ts          CodeMirror 6
    preview.ts         markdown-it 리치 프리뷰
    table-md.ts        순수 Markdown 표 헬퍼 (편집/삽입/삭제, 라운드트립 안전)
    preview-table-edit.ts  프리뷰 표 편집 (MD 동기화 격리)
    humanize-*.ts      윤문/문체 레이어 (탐소노미·가드·엔진)
    provider-settings-panel.ts / style-setting-panel.ts  설정 UI
    unified-chat-*.ts  통합 채팅 (히스토리 병합, 프롬프트)
```

## 알려진 한계
- **Apple Silicon 전용.** Intel Mac은 지원하지 않습니다.
- **코드 서명 없음(v1).** 첫 실행 시 Gatekeeper 우회가 필요합니다. 서명·공증은 후속 과제입니다.
- **영어 윤문은 실험적**입니다(한국어 윤문과 동등하지 않습니다).
- **Gemini·Grok 네이티브 구독 로그인 미지원**(OpenRouter 경유로 사용).
- **에디터 인라인 이미지 임베드 미지원.** 문서 본문에 이미지를 삽입/표시하는 기능은 후속 과제입니다(단, **AI 채팅에 이미지 첨부**는 지원합니다).
- **자동 교체식 업데이트 미지원.** 미서명 앱이라 새 버전은 인앱 알림으로만 안내하며, 설치는 수동입니다.

## 보안 노트
- `src/main/codex-auth.ts`의 OpenAI `CLIENT_ID`는 device-code 플로우용 **공개 클라이언트 ID**입니다(비밀값이 아님). ChatGPT 구독 연동은 비공식(unofficial) 경로이며, 안정적인 대안으로 Claude(API 키)·OpenRouter(API 키)를 권장합니다.
- API 키·토큰은 렌더러로 전달되지 않으며(끝 4자리만 표시), 로그에 남기지 않습니다. ChatGPT OAuth 토큰도 `safeStorage`로 암호화 저장하거나, 암호화를 쓸 수 없으면 **세션 메모리에만** 두고 디스크에 평문으로 쓰지 않습니다.
- 외부 링크는 `http`·`https`·`mailto`만 엽니다.
- 자세한 내용: [`SECURITY.md`](./SECURITY.md)(보안 정책·취약점 신고) · [`PRIVACY.md`](./PRIVACY.md)(로컬 저장 데이터·전송 범위).

## 라이선스
[MIT](./LICENSE). 한글 AI 티 제거 탐소노미는 [im-not-ai](https://github.com/epoko77-ai/im-not-ai)(MIT)에서 착안해 재구성했습니다 — 자세한 출처는 [`NOTICE`](./NOTICE) 참고.
