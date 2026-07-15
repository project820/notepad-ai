# Notepad AI — 에이전트 운영 규칙 (AGENTS.md)

이 저장소는 **project820 소유**의 macOS(Apple Silicon) Markdown 에디터(Electron + CodeMirror 6 + markdown-it)다. 지금부터 모든 개발은 **repo 중심**으로, 예외 없이 **이슈 보고 → PR** 흐름으로만 이뤄진다. 이 파일이 에이전트 운영 규칙의 단일 소스다 — 규칙 변경은 이 파일 수정(PR 경유)으로만 한다.

GJC 컨트리뷰션 워크스페이스의 운영 규칙을 이 저장소가 **소유 repo**라는 맥락에 맞게 응용한 것이다.

## 불변 규칙 (항상 적용)

- **신원**: 모든 공개 활동(커밋·PR·이슈·코멘트)은 project820 계정으로 한다. 커밋 author/committer 이메일은 project820 GitHub noreply(`<id>+project820@users.noreply.github.com`)로 귀속되어야 한다.
- **로컬 유출 금지 (최고 심각도)**: 로컬 절대 경로(홈 디렉토리·`$HOME` 전개값)·기기명·개인 설정을 코드·diff·커밋 메시지·PR 본문에 포함하는 것은 가장 심각한 위반이다. 발견 즉시 제출 중단.
- **No-secret**: API 키·토큰·`.env`·자격증명을 커밋하지 않는다. 렌더러 프로세스에 secret을 노출하지 않으며(비밀은 `safeStorage` 또는 메모리 전용), 렌더러에는 비-secret 메타데이터만 전달한다. [SECURITY.md](./SECURITY.md) 준수.
- **스코프 가드**: 모든 PR 주제는 착수 전 사용자 승인 필수. 큰 변경(새 기능·아키텍처)은 GitHub 이슈를 먼저 열어 합의한 뒤 작업한다. 작은 수정(버그·문서·테스트)은 승인만으로 진행. 승인 범위 밖으로 스코프가 확대되면 작업 중단 + 재승인.
- **표면 규율**: "MD가 source of truth" — 프리뷰/표/타이포 편집이 원본 Markdown을 손상시키지 않는다. 사용자 대면 문자열은 i18n 5로케일(en/ko/zh-Hans/zh-Hant/ja)로, 하드코딩 금지. 기존 UI 토큰/패턴 재사용([DESIGN.md](./DESIGN.md)), 평행 컨벤션 신설 금지.
- **close-flow 불가침**: `src/main/app-windows.ts`, `close-coordinator.ts`, `close-guard.ts`, `src/renderer/{main,doc-lifecycle,preview-editing,close-query-state}.ts`의 저장/종료/펜스(`isSaveFenced`/`hasPreviewSyncFailure`/close lease) 로직은 데이터 유실 위험 영역이다. 변경 시 `test:close-dialog-smoke`(대용량 포함) 무회귀 필수.
- **자동 머지 절대 금지 (사용자 지시, 2026-07-15)**: 사용자의 **명시적 머지 승인**(해당 PR 번호를 특정한 승인) 없이는 어떤 PR도 머지하지 않는다. PR 오픈과 머지를 같은 턴/같은 세션 흐름에서 연달아 실행하는 것, `gh pr merge --auto`, self-merge, admin merge 전부 포함해 금지. 3중 게이트를 전부 통과해도 마지막 머지 버튼은 항상 사용자 몫이다. 위반 시 즉시 롤백 대상(선례: #23/#24/#26 → `main`을 `670f280`으로 리셋).

## 개발 흐름 (repo 중심)

1. **이슈 우선**: 버그/기능은 먼저 GitHub 이슈로 등록한다(재현 절차·기대 동작·스코프·수용 기준). 이슈 없는 큰 변경 금지.
2. **토픽 브랜치**: `main` 기반 토픽 브랜치에서만 작업한다(`fix/…`, `feat/…`, `chore/…`, `revision/…`). **`main` 직접 push 금지.**
3. **PR**: 대상 브랜치는 `main`. PR 본문에 변경 내용·이유·연결 이슈(`Closes #N`)·실행한 검증을 명시하고, 사용자 대면 변경은 스크린샷/체크리스트를 포함한다.
4. **머지**: 아래 3중 게이트를 모두 통과하고 **사용자 최종 승인**을 받은 뒤에만 머지한다.

## PR 제출 3중 게이트 (셋 다 없이는 머지하지 않는다)

**① 검증 게이트** — [CONTRIBUTING.md](./CONTRIBUTING.md) PR 체크리스트 전부 green. CI(`.github/workflows/ci.yml`)와 정합:
- `npm run typecheck` / `npm run test` / `npm run build`
- `npm run preflight:tessdata`
- `npm run test:security-e2e` / `test:converter-e2e` / `test:html-export-direct` / `test:roundtrip-smoke`
- close-flow를 건드리면 `npm run test:close-dialog-smoke`(⌘Q·대용량 discard/save 포함)
- `npm run knip` / `npm audit --omit=dev --audit-level=high`

**② 리뷰 게이트** — 데이터안전·보안·close-flow·인증(구독 로그인/cli-trust)·HTML 생성 표면을 건드리는 PR은 내부 GPT-5.6 리뷰(`architect`/`critic` 레인) 또는 `insane-review`로 **잔여 CRITICAL/HIGH 0(SHIP)** 까지 라운드를 돈다. 지적 반영으로 코드가 바뀌면 변경 범위 재리뷰 1회 추가. 같은 지적 2회 이상 반복 시 escalation.

**③ 개인정보 스캔 + 사용자 최종 승인** — PR 머지 직전 4표면(커밋 author/committer, diff 전체, 커밋 메시지, PR 본문) × 항목(실명·개인메일·연락처·로컬 절대경로·기기명·개인설정) 교차 검출 **0건**. 그 후 사용자 최종 승인.

## PR 사후 운영 — 코멘트 관리는 서브에이전트에 일임

- **PR 개설 후 코멘트·리뷰·CI 상태의 관리·관찰은 서브에이전트에 일임한다.** 오케스트레이터(메인 세션)는 위임하고 결과를 종합·판단만 한다. 직접 상시 폴링하지 않는다.
- **서브에이전트 임무**: 지정한 PR 번호의 신규 리뷰 코멘트/변경 요청/CI 결과를 관찰(`gh pr view`, `gh pr checks`, `gh api …/comments`)하고, SLA로 분류해 조치안을 오케스트레이터에 보고한다. 코드 변경이 필요하면 오케스트레이터가 `executor`로 반영 후 게이트를 재실행한다. 서브에이전트는 읽기·관찰·보고만 하며 직접 머지/force-push하지 않는다.
- **목표-수명(goal-scoped)**: 감시 루프는 그 PR을 실행하는 세션이 소유하고 그 세션 안에서만 산다. 상시 데몬을 남기지 않는다. PR이 머지되고 안정(무이벤트)이 확인되면 서브에이전트는 `WATCH_COMPLETE`를 남기고 종료한다.
- **SLA**:

  | 이벤트 | 대응 |
  |---|---|
  | 일반 코멘트 / CI 실패 | 24시간 내 배치 처리 |
  | P1 (머지 차단·보안·긴급) | 인지 즉시 최우선 착수 |
  | 같은 지적 2회 이상 반복 | insane-review/GPT-5.6 council로 escalation |

- **적응형 주기(권장 기본)**: 활성 3분 → 마지막 이벤트 후 30분 무활동이면 30분 → 머지 후 10분. 머지 후 60분 무이벤트면 해당 PR을 성공 확정하고 루프를 종료한다.
- **인계**: 이후 작업하는 새 세션이 자기 목표 스코프의 PR만 감시한다. 다른 세션이 소유한 감시 상태를 침범하지 않는다.

## Non-Goals

- 저장소 전체 상시 모니터링, 무관한 PR 관찰
- 상시 백그라운드 데몬/감시 프로세스 상주
- 자동화 인프라(이벤트 wiring, 스캔 스크립트, council 자동화)의 즉시 구축 — 필요해질 때 별도 PR로 진행
