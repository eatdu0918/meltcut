# MeltCut

OpenCut의 편집 화면에 MLT 렌더링 엔진을 붙인 데스크톱 영상 편집기입니다. MLT는 Shotcut과 Kdenlive가 쓰는 엔진입니다.

- 편집 화면은 [OpenCut (classic)](https://github.com/opencut-app/opencut-classic)을 그대로 씁니다.
- 내보내기와 정밀 미리보기는 MLT(`melt`)가 처리합니다.
- 프로젝트와 미디어는 내 컴퓨터에만 저장되고, 앱은 인터넷 없이 동작합니다.

## 설치 (Windows)

[Releases](../../releases)에서 `MeltCut-Setup-<버전>.exe`를 받아 실행합니다. MLT 엔진이 함께 들어 있어 따로 설치할 것은 없습니다.

설치 파일에는 코드 서명이 없어서 Windows가 "PC 보호" 경고를 띄울 수 있습니다. "추가 정보 → 실행"을 누르면 설치됩니다.

## 할 수 있는 것

| 기능 | 설명 |
|---|---|
| 내보내기 | MP4(H.264 / HEVC / AV1), WebM(VP9), MOV(ProRes), GIF, MP3, WAV. 해상도와 품질 선택 |
| MLT 미리보기 | 미리보기 툴바의 **MLT** 버튼. 재생 위치의 프레임을 내보내기와 똑같이 보여 줍니다 |
| 효과 26종 | 노출, 색 보정, 색조, 색온도, 생동감, 색 입히기, 흑백, 세피아, 반전, 선명하게, 노이즈 제거, 비네트, 글로우, 모자이크, 포스터화, 윤곽선, RGB 분리, 방향 블러, 물결, 렌즈 왜곡, 필름 그레인, 오래된 필름, 거울, 뒤집기, 자르기, 크로마키 |
| 전환 11종 | 페이드, 슬라이드 4방향, 줌 인/아웃, 와이프 4방향. 클립의 시작과 끝에 겁니다. 같은 트랙에서 두 클립이 맞닿아 있으면 두 클립 사이의 전환이 됩니다 |
| 프로젝트 파일 | `.meltcut` 파일로 저장하고 다시 열 수 있습니다 |

OpenCut의 기존 기능(자르기, 텍스트, 도형, 스티커, 마스크, 키프레임, 속도 변경, 블렌드 모드, 흐림·그라디언트 배경)은 그대로 쓸 수 있고 MLT 내보내기에 반영됩니다.

### 알아 둘 점

- MLT 전용 효과와 전환은 실시간 미리보기에는 보이지 않습니다. **MLT** 버튼을 켜면 보입니다.
- 크로스 디졸브는 뒤 클립의 시작(In)에 페이드를 걸면 됩니다. 맞닿은 앞 클립의 마지막 화면이 전환 동안 밑에 깔립니다.
- 색상처럼 모양 자체가 키프레임으로 변하는 텍스트·도형은 내보낼 때 프레임마다 그림으로 그려서, 긴 클립은 준비에 시간이 걸립니다.
- 온라인 음원 검색(Sounds 탭)은 MeltCut에 없습니다. 음원은 파일로 불러옵니다.
- 내보낼 때 반영하지 못한 것이 있으면 무엇이 빠졌는지 알려 줍니다.

## 소스에서 실행

[Bun](https://bun.sh) 1.2 이상과, `melt`가 들어 있는 [Shotcut](https://shotcut.org/download/) 설치가 필요합니다.

```bash
bun install
bun run desktop:dev
```

Shotcut을 기본 위치(`C:\Program Files\Shotcut`)가 아닌 곳에 설치했다면 `MLT_BIN_DIR` 환경 변수에 그 폴더를 지정합니다. 내보내기 패널의 "Locate MLT"로도 지정할 수 있습니다.

### 설치 파일 만들기

```bash
cd apps/web
bun x next build
cd ../shell
bun run dist -- --engine="C:\Program Files\Shotcut"
```

결과는 `apps/shell/dist/`에 생깁니다. `--engine`에 지정한 폴더의 엔진이 설치 파일에 들어갑니다.

GitHub에 푸시하면 Actions가 테스트와 설치 파일 빌드를 돌리고, `v0.2.0` 같은 태그를 푸시하면 설치 파일이 붙은 릴리스 초안을 만듭니다.

### 테스트

```bash
cd apps/web
bun test src/mlt
```

`src/mlt`의 테스트는 변환 결과를 실제 `melt`로 렌더해 픽셀을 확인합니다. 저장소 루트에서 `bun test`를 실행하면 전체 테스트가 돕니다. 편집 화면 전체를 도는 테스트는 `apps/shell/e2e`에 있고 이렇게 실행합니다.

```bash
cd apps/shell
bun x electron . --e2e=e2e/stage3-export.cjs
```

## 구조

| 위치 | 내용 |
|---|---|
| `apps/web` | 편집 화면 (Next.js). OpenCut 코드 |
| `apps/web/src/mlt` | 타임라인을 MLT 프로젝트로 바꾸는 변환기, 효과·전환 정의, 내보내기·미리보기 화면 |
| `apps/web/src/desktop` | 화면과 데스크톱 껍데기를 잇는 부분, 프로젝트 파일 |
| `apps/shell` | Electron 껍데기. `melt` 실행, 파일 대화상자, 설치 파일 빌드 |
| `rust`, `apps/desktop` | OpenCut에서 온 코드로, MeltCut은 빌드하지 않습니다 |

## 라이선스

MeltCut의 소스는 [MIT](LICENSE)입니다. OpenCut에서 온 코드도 MIT이며 원 저작권 표시를 유지합니다.

설치 파일에 함께 들어가는 MLT 엔진은 Shotcut 공식 배포본에서 가져온 것이고 GPL-3.0 등 별도 라이선스를 따릅니다. 자세한 내용과 소스 위치는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)에 있습니다.

MeltCut은 OpenCut, Shotcut, MLT, Kdenlive 프로젝트와 관계가 없는 별개의 프로젝트입니다.
