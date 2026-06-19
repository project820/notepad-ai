# Notepad AI

애플 실리콘 Mac을 위한, **한국어 사용자 중심의 오픈소스 마크다운 편집기.** Obsidian이 어렵게 느껴지는 분들을 위해, 쉬운 편집기에 실용적인 AI 글쓰기 도우미를 더했습니다.

> 공개 오픈소스 프로젝트입니다. 코드 서명이 없는 v1 빌드이므로 첫 실행 시 Gatekeeper 우회가 한 번 필요합니다(아래 설치 안내 참고).

## 설치

1. [Releases](https://github.com/project820/notepad-ai/releases)에서 `Notepad.AI-<version>-arm64.dmg`를 내려받아 엽니다.
2. `Notepad AI`를 `Applications`로 드래그합니다.
3. **첫 실행(미서명 앱):** Finder에서 앱을 **우클릭 → 열기**를 선택하고, 경고창에서 다시 **열기**를 누릅니다. 그래도 막히면 터미널에서:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Notepad AI.app"
   ```
4. 함께 제공되는 `install-guide.html`를 브라우저로 열면 슬라이드형 안내를 볼 수 있습니다.

> **Apple Silicon 전용**입니다(Intel Mac 미지원).

## 기능

### 편집기
- CodeMirror 6 + 실시간 리치 프리뷰(markdown-it, GFM, 체크박스)
- 프리뷰에서 직접 편집(contenteditable) → MD 동기화
- 툴바: 굵게 / 이탤릭 / 취소선 / 인라인 코드 / H1~H3 / 인용 / 목록 / 체크리스트 / 링크 / 코드블록 / 수평선
- **표 편집(재설계):** Excel식으로 셀을 고르고 그 셀 기준 좌/우 열·상/하 행을 추가합니다. MD가 항상 진실(source of truth)이며, 프리뷰 표 편집이 원본 MD를 깨뜨리지 않습니다. 데이터가 있는 행/열은 삭제 전 확인을 받습니다.
- 보기 전환: 좌우 분할 / 리치 전용 / RAW 전용

### 파일 가져오기
- HWP · HWPX · DOCX · PDF · XLSX → Markdown 자동 변환(`kordoc`)

### AI 기능
- **통합 채팅** — 초안 작성·수정·상담을 한 화면에서. 결과를 문서에 바로 삽입/교체할 수 있는 집필 협업자입니다.
- **블록 AI** — 선택한 텍스트를 그 자리에서 첨삭/대안 제시.
- **문체 설정** — 글쓰기 난이도(초등~전문가)와 자연스러움(윤문 강도)을 하나의 설정으로 조절합니다.
- **항상 켜진 윤문(한글 AI 티 제거)** — 모든 AI 출력이 기본으로 자연스러운 한국어로 나옵니다. 코드·인용·수치·고유명사 등 사실은 보존합니다. (영어 윤문은 최소 기능의 **실험적(Experimental)** 단계입니다.)

### AI 모델 설정(다중 프로바이더)
사용할 AI를 직접 고릅니다. v1에서 지원하는 연결 방식:

| 프로바이더 | 연결 방식 |
|-----------|-----------|
| ChatGPT | 구독 로그인(device-code OAuth) |
| Claude (Anthropic) | API 키 |
| OpenRouter | API 키 (Gemini·Grok 등 여러 모델 접근) |

- 내장 **모델 카탈로그**에서 프로바이더와 모델을 고르며, 카탈로그에 없는 모델은 **커스텀 모델 ID**로 직접 입력할 수 있습니다.
- 아무 프로바이더도 연결하지 않으면 AI 기능은 잠기고, 연결을 안내합니다.
- API 키는 macOS Keychain(`safeStorage`)으로 암호화 저장하며, 암호화를 쓸 수 없는 환경에서는 **디스크에 저장하지 않고** 해당 세션 메모리에만 둡니다. 키는 화면에 끝 4자리만 표시됩니다.
- **Gemini·Grok 네이티브 구독 로그인**은 v1 범위가 아니며 후속 과제입니다(현재는 OpenRouter로 접근).

## 개발

```bash
npm install
npm run dev          # Electron + Vite HMR 개발 모드
npm run typecheck    # 타입 검사 (main + renderer)
npm run test         # 단위 테스트 (vitest)
npm run build        # main + renderer 빌드
npm run build:dmg    # 배포용 DMG 생성 → release/
```

## 구조

```
src/
  main/
    main.ts            BrowserWindow, 메뉴, 파일 IO, IPC
    preload.ts         contextBridge (window.api)
    ai/                다중 프로바이더 레지스트리 (chatgpt/claude/openrouter), 모델 카탈로그, API 키 저장
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
- 이미지 임베드, 멀티탭/멀티윈도우, 자동 업데이트는 미지원입니다.

## 보안 노트
- `src/main/codex-auth.ts`의 OpenAI `CLIENT_ID`는 device-code 플로우용 **공개 클라이언트 ID**입니다(비밀값이 아님). ChatGPT 구독 연동은 비공식(unofficial) 경로이며, 안정적인 대안으로 Claude(API 키)·OpenRouter(API 키)를 권장합니다.
- API 키·토큰은 렌더러로 전달되지 않으며(끝 4자리만 표시), 로그에 남기지 않습니다. ChatGPT OAuth 토큰도 `safeStorage`로 암호화 저장하거나, 암호화를 쓸 수 없으면 **세션 메모리에만** 두고 디스크에 평문으로 쓰지 않습니다.
- 외부 링크는 `http`·`https`·`mailto`만 엽니다.
- 자세한 내용: [`SECURITY.md`](./SECURITY.md)(보안 정책·취약점 신고) · [`PRIVACY.md`](./PRIVACY.md)(로컬 저장 데이터·전송 범위).

## 라이선스
[MIT](./LICENSE). 한글 AI 티 제거 탐소노미는 [im-not-ai](https://github.com/epoko77-ai/im-not-ai)(MIT)에서 착안해 재구성했습니다 — 자세한 출처는 [`NOTICE`](./NOTICE) 참고.
