import { expect, test, type Page } from "@playwright/test";

// SA-100 직원 계정(대표자 전용): 목록 · 직원 추가(이름·휴대폰·이메일·초기 비밀번호·권한) · 정보·권한 수정 · 비밀번호 재설정 · 비활성화,
// 직원이 주소로 들어오면 「대표자만 볼 수 있습니다」. 실행마다 새 이메일로 직원을 만든다(폐기용 DB).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

// 로그인 화면에 대표자·직원 탭이 있으면(#161) 계정 종류에 맞는 탭을 고른다
async function login(page: Page, email: string, password = PASSWORD, next = "/seller/staff") {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  const tab = page.getByRole("tab", { name: email === "demo-owner@example.com" ? "대표자" : "직원" });
  if (await tab.count()) await tab.click();
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
}

// 본인확인을 쓸 수 있는 서버(개발·테스트 모드)에서는 연결 전 직원이 로그인하면 연결 안내(AU-012)로 간다: 「나중에 할게요」로 넘긴다
async function skipIdentityLink(page: Page) {
  await page.waitForURL((u) => u.pathname !== "/seller/login");
  if (new URL(page.url()).pathname === "/seller/identity-link") await page.getByRole("button", { name: "나중에 할게요" }).click();
}

const uniq = () => `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 36 ** 2).toString(36)}`;
const row = (page: Page, email: string) => page.getByTestId("staff-row").filter({ hasText: email });

async function addStaff(page: Page, s: { name: string; phone: string; email: string; password: string }) {
  await page.getByLabel("이름", { exact: true }).fill(s.name);
  await page.getByLabel("휴대폰 번호").fill(s.phone);
  await page.getByLabel("이메일 (로그인 아이디)").fill(s.email);
  await page.getByLabel("초기 비밀번호").fill(s.password);
}

test("대표자: 메뉴에서 직원 계정으로 들어가 목록을 보고, 직원을 추가하면 목록에 권한과 함께 나온다", async ({ page }) => {
  await login(page, "demo-owner@example.com", PASSWORD, "/seller/products");
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "직원 계정" }).click();
  await expect(page).toHaveURL(/\/seller\/staff$/);
  await expect(page.getByRole("heading", { name: /직원 계정/ })).toBeVisible();
  // 대표자 줄과 데모 직원(dev-seed 3명)
  await expect(page.getByText("대표자 · 모든 권한")).toBeVisible();
  await expect(row(page, "demo-staff@example.com")).toContainText("상품");
  await expect(row(page, "demo-none@example.com")).toContainText("켜진 권한 없음");
  // 대표자만 하는 일은 고를 수 없다
  for (const label of ["결제(PG) 연결", "구독 · 결제", "직원 관리", "적립금 실지급"]) await expect(page.getByLabel(`${label} · 대표자만`)).toBeDisabled();
  await shot(page, "SA-100");

  // 빈 칸으로 만들기 → 칸마다 안내, 첫 칸으로 포커스
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(page.getByText("이름을 입력해 주십시오")).toBeVisible();
  await expect(page.getByText("01로 시작하는 휴대폰 번호를 숫자로 입력해 주십시오")).toBeVisible();
  await expect(page.getByText("로그인에 사용할 이메일을 입력해 주십시오")).toBeVisible();
  await expect(page.getByLabel("이름", { exact: true })).toBeFocused();

  // 이름 규칙은 서버와 같다: 폭 없는 공백 같은 서식 문자는 안 되고, 50자(코드포인트)까지
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/seller/staff") && r.method() === "POST") posts.push(r.url());
  });
  await page.getByLabel("이름", { exact: true }).fill("김\u200b직원");
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(page.getByText("이름에 사용할 수 없는 문자가 있습니다")).toBeVisible();
  await page.getByLabel("이름", { exact: true }).fill("가".repeat(51));
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(page.getByText("이름은 50자까지 입력할 수 있습니다")).toBeVisible();
  expect(posts).toHaveLength(0);

  // 초기 비밀번호는 가려 두고 「보기」로만 잠깐 보여 준다
  await expect(page.getByLabel("초기 비밀번호")).toHaveAttribute("type", "password");
  await page.getByLabel("초기 비밀번호").fill("pw-visible-check");
  await page.getByRole("button", { name: "보기" }).click();
  await expect(page.getByLabel("초기 비밀번호")).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "숨기기" }).click();
  await expect(page.getByLabel("초기 비밀번호")).toHaveAttribute("type", "password");

  const id = uniq();
  const s = { name: `방송보조${id}`, phone: "010-1234-5678", email: `staff-${id}@example.com`, password: `pw-${id}-init` };
  await addStaff(page, s);
  // 묶음 「방송만」은 방송 진행·오버레이 편집만 켠다
  await page.getByRole("button", { name: "방송만" }).click();
  await expect(page.getByRole("checkbox", { name: "방송 진행", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "오버레이 편집", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "상품", exact: true })).not.toBeChecked();
  // 「운영 전체」는 고객 정보 보기를 켜지 않는다(개인정보는 대표자가 따로 켬)
  await page.getByRole("button", { name: "운영 전체" }).click();
  await expect(page.getByRole("checkbox", { name: "상품", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "쇼핑몰 설정", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "고객 정보 보기", exact: true })).not.toBeChecked();
  await expect(page.getByText("고객 이름·연락처·주소를 볼 수 있습니다").first()).toBeVisible();
  await page.getByRole("button", { name: "방송만" }).click();
  // 「보기」로 본 채 만들어도, 비워진 칸은 다시 가린다(다음 직원 비밀번호가 바로 보이지 않게)
  await page.getByRole("button", { name: "보기" }).click();
  await expect(page.getByLabel("초기 비밀번호")).toHaveAttribute("type", "text");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/seller/staff") && r.method() === "POST");
  await page.getByRole("button", { name: "계정 생성" }).click();
  // 하이픈은 빼고 숫자만 보낸다
  expect((await sent).postDataJSON()).toMatchObject({ name: s.name, phone: "01012345678", email: s.email, permissions: ["BROADCAST_RUN", "OVERLAY_EDIT"] });
  await expect(page.getByText(`${s.name} 계정을 생성했습니다`, { exact: false })).toBeVisible();
  await expect(row(page, s.email)).toContainText("방송 진행");
  await expect(row(page, s.email)).toContainText("010-1234-5678 · 본인확인 전");
  // 입력 칸은 비워지고 비밀번호 칸은 다시 가려진다
  await expect(page.getByLabel("이메일 (로그인 아이디)")).toHaveValue("");
  await expect(page.getByLabel("초기 비밀번호")).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "보기" })).toBeVisible();

  // 같은 이메일은 다시 만들 수 없다
  await addStaff(page, { ...s, name: "다른 사람" });
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(page.getByText("이미 사용 중인 이메일입니다")).toBeVisible();
  await expect(page.getByLabel("이메일 (로그인 아이디)")).toBeFocused();
});

test("대표자: 직원 이름·휴대폰·권한을 고치면 바로 목록에 반영되고, 연결된 직원 번호를 바꾸면 다시 본인확인해야 한다고 알려 준다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/staff$/);
  const id = uniq();
  const s = { name: `포장${id}`, phone: "01011112222", email: `pack-${id}@example.com`, password: `pw-${id}-init` };
  await addStaff(page, s);
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(row(page, s.email)).toContainText("켜진 권한 없음");

  await page.getByRole("button", { name: `${s.name} 정보 · 권한 수정` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `${s.name} 정보 · 권한 수정` })).toBeVisible();
  await expect(dialog.getByText("본인확인 전")).toBeVisible();
  // 바꾼 것이 없으면 저장할 수 없다
  await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
  await dialog.getByLabel("이름").fill(`${s.name}\u200b`);
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog.getByText("이름에 사용할 수 없는 문자가 있습니다")).toBeVisible();
  await dialog.getByLabel("이름").fill(`${s.name}팀장`);
  await dialog.getByLabel("휴대폰 번호").fill("0101");
  await dialog.getByRole("checkbox", { name: "상품", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "주문·배송", exact: true }).check();
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog.getByText("01로 시작하는 휴대폰 번호를 숫자로 입력해 주십시오")).toBeVisible();
  await dialog.getByLabel("휴대폰 번호").fill("01033334444");
  await shot(page, "SA-100-edit");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(`${s.name}팀장 정보를 저장했습니다`)).toBeVisible();
  await expect(row(page, s.email)).toContainText(`${s.name}팀장`);
  await expect(row(page, s.email)).toContainText("010-3333-4444");
  await expect(row(page, s.email)).toContainText("상품");
  await expect(row(page, s.email)).toContainText("주문·배송");

  // 본인확인을 연결한 직원(목록 응답의 연결 여부만 바꿔 화면 상태를 본다): 번호를 바꾸면 다시 본인확인해야 한다고 알려 준다
  await page.route("**/api/seller/staff", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as { staff: { email: string; identityLinked: boolean }[] };
    await route.fulfill({ response: res, json: { staff: body.staff.map((x) => (x.email === s.email ? { ...x, identityLinked: true } : x)) } });
  });
  await page.reload();
  await expect(row(page, s.email)).toContainText("본인확인 연결됨");
  await page.getByRole("button", { name: `${s.name}팀장 정보 · 권한 수정` }).click();
  await expect(dialog.getByText("연결됨", { exact: true })).toBeVisible();
  await expect(dialog.getByText("번호를 바꾸면 직원이 본인확인을 다시 해야 합니다.")).toHaveCount(0);
  await dialog.getByLabel("휴대폰 번호").fill("01055556666");
  await expect(dialog.getByText("번호를 바꾸면 직원이 본인확인을 다시 해야 합니다.")).toBeVisible();
  await expect(dialog.getByText("본인확인 전")).toBeVisible();
  await shot(page, "SA-100-phone-change");
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("대표자: 직원 비밀번호를 재설정하면 새 비밀번호로만 로그인되고, 비활성화하면 로그인할 수 없다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/staff$/);
  const id = uniq();
  const s = { name: `퇴사${id}`, phone: "01077778888", email: `bye-${id}@example.com`, password: `pw-${id}-init` };
  await addStaff(page, s);
  await page.getByRole("checkbox", { name: "상품", exact: true }).check();
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(row(page, s.email)).toBeVisible();

  await page.getByRole("button", { name: `${s.name} 비밀번호 재설정` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("새 비밀번호")).toHaveAttribute("type", "password");
  await dialog.getByLabel("새 비밀번호").fill("short");
  await dialog.getByRole("button", { name: "재설정" }).click();
  await expect(dialog.getByText("8자 이상으로 정해 주십시오")).toBeVisible();
  const next = `pw-${id}-reset`;
  await dialog.getByLabel("새 비밀번호").fill(next);
  await shot(page, "SA-100-password");
  await dialog.getByRole("button", { name: "재설정" }).click();
  await expect(page.getByText(`${s.name} 비밀번호를 변경했습니다`, { exact: false })).toBeVisible();

  // 예전 비밀번호는 안 되고 새 비밀번호로 직원 로그인
  const staffPage = await page.context().browser()!.newPage();
  await login(staffPage, s.email, s.password, "/seller/products");
  await expect(staffPage.locator("#login-err")).toBeVisible();
  await login(staffPage, s.email, next, "/seller/products");
  await skipIdentityLink(staffPage);
  await expect(staffPage).toHaveURL(/\/seller\/products$/);

  // 직원이 로그인해 있는 동안 대표자가 권한을 켜면, 직원이 다음 화면으로 옮길 때 메뉴에 바로 나온다(새로고침 없이)
  const staffMenu = staffPage.getByRole("complementary", { name: "파트너스 메뉴" });
  await expect(staffMenu.getByRole("link", { name: "주문", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: `${s.name} 정보 · 권한 수정` }).click();
  await dialog.getByRole("checkbox", { name: "주문·배송", exact: true }).check();
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await staffPage.getByRole("link", { name: "재고 관리" }).click();
  await expect(staffPage).toHaveURL(/\/seller\/products\/stock$/);
  await expect(staffMenu.getByRole("link", { name: "주문", exact: true })).toBeVisible();

  // 비활성화: 목록에서 비활성으로 바뀌고 관리 버튼이 없어지며, 그 직원은 다시 로그인할 수 없다
  await page.getByRole("button", { name: `${s.name} 비활성화` }).click();
  await expect(dialog.getByRole("heading", { name: `${s.name} 계정을 비활성화하시겠습니까?` })).toBeVisible();
  await shot(page, "SA-100-disable");
  await dialog.getByRole("button", { name: "비활성화" }).click();
  await expect(page.getByText(`${s.name} 계정을 비활성화했습니다`)).toBeVisible();
  await expect(row(page, s.email)).toContainText("비활성");
  await expect(page.getByRole("button", { name: `${s.name} 비밀번호 재설정` })).toHaveCount(0);
  await staffPage.context().clearCookies();
  await login(staffPage, s.email, next, "/seller/products");
  await expect(staffPage).toHaveURL(/\/seller\/login/);
  await staffPage.close();
});

test("저장 응답을 놓치면 직원 목록을 다시 읽어 실제 결과를 보여 준다(직원 추가·정보·권한 수정)", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/staff$/);
  const id = uniq();
  const s = { name: `유실${id}`, phone: "01033334444", email: `lost-${id}@example.com`, password: `pw-${id}-init` };

  // 서버는 만들고 응답만 끊긴다(POST). 그 뒤 확인용 목록 읽기(GET)를 listFailures번 실패시킨다(보내기 전 목록 읽기는 그대로)
  const isList = (u: URL) => u.pathname === "/api/seller/staff";
  const loseCreate = async (listFailures: number) => {
    await page.unroute(isList);
    let posted = false;
    let fails = listFailures;
    await page.route(isList, async (route) => {
      if (route.request().method() === "POST") {
        if (posted) return route.continue();
        posted = true;
        await route.fetch();
        return route.abort("connectionreset");
      }
      if (posted && fails > 0) {
        fails -= 1;
        return route.fulfill({ status: 500, json: { error: "internal" } });
      }
      return route.continue();
    });
  };

  // ① 응답·확인용 목록 읽기가 모두 실패: 실패라고 하지 않고 칸을 잠근 채 「확인」·「재전송」만 둔다 → 확인하면 만든 것으로 처리
  await addStaff(page, s);
  await page.getByRole("checkbox", { name: "상품", exact: true }).check();
  await loseCreate(1);
  await page.getByRole("button", { name: "계정 생성" }).click();
  const unclear = page.getByTestId("sa-unclear");
  await expect(unclear).toContainText("계정이 생성되었을 수 있습니다.");
  await expect(unclear).toContainText("목록을 읽지 못해 결과를 확인하지 못했습니다");
  await expect(page.getByLabel("초기 비밀번호")).toBeDisabled();
  await expect(page.getByLabel("이름", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "계정 생성" })).toBeDisabled();
  await shot(page, "SA-100-unclear");
  await unclear.getByRole("button", { name: "확인" }).click();
  await expect(page.getByText(`${s.name} 계정을 생성했습니다`, { exact: false })).toBeVisible();
  await expect(page.getByLabel("이메일 (로그인 아이디)")).toHaveValue("");
  await expect(row(page, s.email)).toContainText("상품");

  // ② 불분명한 상태에서 「새로 입력」으로 풀면 이전 요청이 처리되었을 수 있다고 안내한다. 비밀번호를 바꿔 비밀번호를 바꿔 다시 보내면 email_taken: 만든 것으로 보지 않고 안내만 한다
  const id2 = uniq();
  const s2 = { name: `재입력${id2}`, phone: "01033335555", email: `again-${id2}@example.com`, password: `pw-${id2}-first` };
  await addStaff(page, s2);
  await loseCreate(1);
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(unclear).toBeVisible();
  await unclear.getByRole("button", { name: "새로 입력" }).click();
  await expect(page.getByTestId("sa-notice")).toHaveText("이전 계정 생성 요청이 처리되었을 수 있습니다. 목록에서 확인한 뒤 입력해 주십시오");
  await expect(page.getByLabel("초기 비밀번호")).toBeEnabled();
  await page.getByLabel("초기 비밀번호").fill(`pw-${id2}-second`);
  const retried = page.waitForResponse((r) => r.url().endsWith("/api/seller/staff") && r.request().method() === "POST");
  await page.getByRole("button", { name: "계정 생성" }).click();
  expect((await retried).status()).toBe(409);
  await expect(page.getByText("이 이메일로 등록된 계정이 이미 있습니다. 목록에서 확인하고 필요하면 비밀번호를 재설정해 주십시오")).toBeVisible();
  await expect(page.getByText(`${s2.name} 계정을 생성했습니다`, { exact: false })).toHaveCount(0);
  await expect(page.getByLabel("이메일 (로그인 아이디)")).toHaveValue(s2.email);
  await expect(row(page, s2.email)).toBeVisible();

  // ③ 전각 글자 이름: 서버는 NFKC로 저장한다. 응답을 놓쳐도 같은 규칙으로 비교해 만든 것으로 처리
  const id3 = uniq();
  const s3 = { name: `ＡＢ직원${id3}`, phone: "01033336666", email: `wide-${id3}@example.com`, password: `pw-${id3}-init` };
  await page.getByLabel("이메일 (로그인 아이디)").fill("");
  await addStaff(page, s3);
  await loseCreate(0);
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(page.getByText(`AB직원${id3} 계정을 생성했습니다`, { exact: false })).toBeVisible();
  await expect(row(page, s3.email)).toContainText(`AB직원${id3}`);

  await page.unroute(isList);

  // 권한 수정: 서버는 저장했는데 응답이 끊긴다 → 다시 읽어 보낸 값과 같으므로 저장했다고 알리고 목록에 반영
  await page.getByRole("button", { name: `${s.name} 정보 · 권한 수정` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: "주문·배송", exact: true }).check();
  await page.route(
    (u) => u.pathname.endsWith("/permissions"),
    async (route) => {
      await route.fetch();
      return route.abort("connectionreset");
    },
    { times: 1 },
  );
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText(`${s.name} 정보를 저장했습니다`)).toBeVisible();
  await expect(row(page, s.email)).toContainText("주문·배송");

  // 이름 수정: 서버 오류(5xx)로 결과가 불분명하고 다시 읽어도 반영 전이다 → 실패로 단정하지 않고 칸을 잠근 채 불분명 상태로 둔다.
  // 같은 값 재저장이 성공하면 저장으로 처리
  await page.getByRole("button", { name: `${s.name} 정보 · 권한 수정` }).click();
  await dialog.getByLabel("이름").fill(`${s.name}바꿈`);
  await page.route((u) => /\/api\/seller\/staff\/[^/]+$/.test(u.pathname), (route) => route.fulfill({ status: 500, json: { error: "internal" } }), { times: 1 });
  await dialog.getByRole("button", { name: "저장" }).click();
  const editUnclear = dialog.getByTestId("se-unclear");
  await expect(editUnclear).toContainText("저장되었을 수 있습니다.");
  await expect(editUnclear).toContainText("아직 반영이 확인되지 않았습니다");
  await expect(dialog.getByLabel("이름")).toBeDisabled();
  await expect(dialog.getByLabel("이름")).toHaveValue(`${s.name}바꿈`);
  const resaved = page.waitForRequest((r) => /\/api\/seller\/staff\/[^/]+$/.test(new URL(r.url()).pathname) && r.method() === "PATCH");
  await editUnclear.getByRole("button", { name: "같은 값으로 재저장" }).click();
  expect((await resaved).postDataJSON()).toMatchObject({ name: `${s.name}바꿈` });
  await expect(page.getByText(`${s.name}바꿈 정보를 저장했습니다`)).toBeVisible();
  await expect(row(page, s.email)).toContainText(`${s.name}바꿈`);
});

test("결과가 불분명한 직원 변경은 실제 상태로 판정한다(이미 있던 계정 오인 금지·비밀번호 같은 값 재전송·비활성화 재조회)", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/staff$/);
  const id = uniq();
  const s = { name: `기존${id}`, phone: "01044445555", email: `old-${id}@example.com`, password: `pw-${id}-init` };
  await addStaff(page, s);
  await page.getByRole("checkbox", { name: "상품", exact: true }).check();
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(row(page, s.email)).toContainText("상품");
  const dialog = page.getByRole("dialog");

  // ② 비밀번호 재설정: 서버는 바꿨는데 응답이 끊긴다 → 「변경되었을 수 있음」, 칸 잠금, 같은 값으로만 다시 보낸다
  await page.getByRole("button", { name: `${s.name} 비밀번호 재설정` }).click();
  const next = `pw-${id}-reset`;
  await dialog.getByLabel("새 비밀번호").fill(next);
  await page.route(
    (u) => u.pathname.endsWith("/password"),
    async (route) => {
      await route.fetch();
      return route.abort("connectionreset");
    },
    { times: 1 },
  );
  await dialog.getByRole("button", { name: "재설정" }).click();
  await expect(dialog.getByTestId("sp-unclear")).toContainText("비밀번호가 변경되었을 수 있습니다.");
  await expect(dialog.getByLabel("새 비밀번호")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "재설정" })).toBeDisabled();
  const resent = page.waitForRequest((r) => r.url().endsWith("/password") && r.method() === "POST");
  await expect(dialog.getByRole("button", { name: "새로 정하기" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "같은 비밀번호로 재전송" }).click();
  expect((await resent).postDataJSON()).toEqual({ newPassword: next });
  await expect(page.getByText(`${s.name} 비밀번호를 변경했습니다`, { exact: false })).toBeVisible();

  // ③ 비활성화: 서버는 처리했는데 응답이 끊긴다 → 목록을 다시 읽어 비활성으로 판정
  await page.getByRole("button", { name: `${s.name} 비활성화` }).click();
  await page.route(
    (u) => u.pathname.endsWith("/disable"),
    async (route) => {
      await route.fetch();
      return route.abort("connectionreset");
    },
    { times: 1 },
  );
  await dialog.getByRole("button", { name: "비활성화" }).click();
  await expect(page.getByText(`${s.name} 계정을 비활성화했습니다`)).toBeVisible();
  await expect(row(page, s.email)).toContainText("비활성");

  // ① 같은 이메일·이름·휴대폰·권한으로 다시 만들기: 요청이 서버에 닿기 전에 끊긴다 → 목록에 같은 값의 (비활성) 계정이 있어도
  // 보내기 전에 있던 계정이라 만든 것으로 보지 않는다. 목록에 없다고 실패로 확정하지도 않고 불분명 상태로 둔다.
  // 같은 값으로 재전송하면 email_taken이고 새 계정이 없으므로(이미 있던 계정이 이메일을 씀) 그때 이메일 안내로 끝낸다
  await addStaff(page, s);
  await page.getByRole("checkbox", { name: "상품", exact: true }).check();
  let aborted = false;
  await page.route(
    (u) => u.pathname === "/api/seller/staff",
    (route) => {
      if (route.request().method() !== "POST" || aborted) return route.continue();
      aborted = true;
      return route.abort("connectionreset");
    },
  );
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(page.getByTestId("sa-unclear")).toContainText("아직 반영이 확인되지 않았습니다");
  await expect(page.getByLabel("초기 비밀번호")).toBeDisabled();
  await page.getByTestId("sa-unclear").getByRole("button", { name: "같은 값으로 재전송" }).click();
  await expect(page.getByText("이 이메일로 등록된 계정이 이미 있습니다. 목록에서 확인하고 필요하면 비밀번호를 재설정해 주십시오")).toBeVisible();
  await expect(page.getByTestId("sa-unclear")).toHaveCount(0);
  await page.unroute((u) => u.pathname === "/api/seller/staff");
  await expect(page.getByText(`${s.name} 계정을 생성했습니다`, { exact: false })).toHaveCount(0);
});

// 응답은 끊겼는데 서버는 아직 처리 중인 경우(늦게 반영): 곧바로 다시 읽으면 「없음」이지만 실패로 확정하지 않는다.
// 끊긴 요청을 붙잡아 두었다가 나중에 같은 요청을 서버에 보내(늦게 끝난 처리) 「확인」으로 성공을 확인한다
test("결과가 불분명한 직원 변경은 늦게 반영돼도 실패로 단정하지 않고, 같은 값으로만 다시 보내게 한다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/staff$/);
  const origin = new URL(page.url()).origin;
  // 첫 요청 하나를 서버에 보내지 않고 끊는다. 나중에 replay()로 같은 요청을 보낸다(늦게 끝난 처리)
  const holdOnce = async (match: (u: URL, method: string) => boolean) => {
    let held: { url: string; method: string; data: string | null } | null = null;
    const pred = (u: URL) => u.origin === origin && u.pathname.startsWith("/api/seller/staff");
    const handler = async (route: import("@playwright/test").Route) => {
      const req = route.request();
      if (held || !match(new URL(req.url()), req.method())) return route.continue();
      held = { url: req.url(), method: req.method(), data: req.postData() };
      return route.abort("connectionreset");
    };
    await page.route(pred, handler);
    return async () => {
      await page.unroute(pred, handler);
      if (!held) throw new Error("붙잡은 요청이 없어요");
      const h = held as { url: string; method: string; data: string | null };
      const r = await page.request.fetch(h.url, { method: h.method, data: h.data ?? undefined, headers: { origin, "content-type": "application/json" } });
      expect(r.ok()).toBe(true);
    };
  };
  const id = uniq();
  const s = { name: `늦게${id}`, phone: "01055556666", email: `late-${id}@example.com`, password: `pw-${id}-init` };

  // 직원 추가: 끊긴 직후 목록에는 없다 → 불분명 유지·칸 잠금(「생성되지 않았습니다」 금지) → 늦게 만들어진 뒤 「확인」으로 성공
  await addStaff(page, s);
  let replay = await holdOnce((u, m) => u.pathname === "/api/seller/staff" && m === "POST");
  await page.getByRole("button", { name: "계정 생성" }).click();
  const addBox = page.getByTestId("sa-unclear");
  await expect(addBox).toContainText("아직 반영이 확인되지 않았습니다");
  await expect(page.getByLabel("초기 비밀번호")).toBeDisabled();
  await expect(page.getByRole("button", { name: "계정 생성" })).toBeDisabled();
  await replay();
  await addBox.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByText(`${s.name} 계정을 생성했습니다`, { exact: false })).toBeVisible();
  await expect(row(page, s.email)).toBeVisible();
  const dialog = page.getByRole("dialog");

  // 정보 수정: 끊긴 직후 다시 읽으면 반영 전 → 불분명 유지·칸 잠금(「저장되지 않았습니다」로 되돌리지 않음) → 늦게 저장된 뒤 「확인」으로 성공
  await page.getByRole("button", { name: `${s.name} 정보 · 권한 수정` }).click();
  await dialog.getByLabel("이름").fill(`${s.name}새`);
  replay = await holdOnce((u, m) => m === "PATCH");
  await dialog.getByRole("button", { name: "저장" }).click();
  const editBox = dialog.getByTestId("se-unclear");
  await expect(editBox).toContainText("아직 반영이 확인되지 않았습니다");
  await expect(dialog.getByLabel("이름")).toBeDisabled();
  await expect(dialog.getByLabel("이름")).toHaveValue(`${s.name}새`);
  await replay();
  await editBox.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByText(`${s.name}새 정보를 저장했습니다`)).toBeVisible();
  const name2 = `${s.name}새`;

  // 정보 수정을 불분명한 채로 닫으면 이전 요청이 처리되었을 수 있다고 안내한다
  await page.getByRole("button", { name: `${name2} 정보 · 권한 수정` }).click();
  await dialog.getByRole("checkbox", { name: "상품", exact: true }).check();
  replay = await holdOnce((u, m) => u.pathname.endsWith("/permissions") && m === "POST");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog.getByTestId("se-unclear")).toBeVisible();
  await dialog.getByRole("button", { name: "닫기" }).click();
  await expect(page.getByText("이전 저장 요청이 처리되었을 수 있습니다 · 목록에서 정보와 권한을 확인해 주십시오")).toBeVisible();
  await replay();

  // 비밀번호 재설정: 다른 비밀번호로 바꾸는 길이 없다(늦게 끝난 첫 요청이 덮을 수 있음). 닫으면 처리되었을 수 있다고 안내한다
  await page.getByRole("button", { name: `${name2} 비밀번호 재설정` }).click();
  await dialog.getByLabel("새 비밀번호").fill(`pw-${id}-late`);
  replay = await holdOnce((u, m) => u.pathname.endsWith("/password") && m === "POST");
  await dialog.getByRole("button", { name: "재설정" }).click();
  await expect(dialog.getByTestId("sp-unclear")).toContainText("비밀번호가 변경되었을 수 있습니다.");
  await expect(dialog.getByRole("button", { name: "새로 정하기" })).toHaveCount(0);
  await expect(dialog.getByLabel("새 비밀번호")).toBeDisabled();
  await dialog.getByRole("button", { name: "닫기" }).click();
  await expect(page.getByText("이전 비밀번호 재설정 요청이 처리되었을 수 있습니다", { exact: false })).toBeVisible();
  await replay();

  // 비활성화: 끊긴 직후 다시 읽으면 아직 활성 → 불분명 유지(「비활성화되지 않았습니다」 금지) → 늦게 처리된 뒤 「확인」으로 성공
  await page.getByRole("button", { name: `${name2} 비활성화` }).click();
  replay = await holdOnce((u, m) => u.pathname.endsWith("/disable") && m === "POST");
  await dialog.getByRole("button", { name: "비활성화" }).click();
  const offBox = dialog.getByTestId("sd-unclear");
  await expect(offBox).toContainText("아직 반영이 확인되지 않았습니다");
  await expect(dialog.getByRole("button", { name: "비활성화", exact: true })).toBeDisabled();
  await replay();
  await offBox.getByRole("button", { name: "확인", exact: true }).click();
  await expect(page.getByText(`${name2} 계정을 비활성화했습니다`)).toBeVisible();
  await expect(row(page, s.email)).toContainText("비활성");
});

// 프록시·서버가 낸 503(본인확인 준비 중이 아님)이나 오류 코드 없는 응답도 처리됐는지 알 수 없다: 실패로 단정하지 않고 불분명으로 다룬다
test("직원 변경이 503·형식 모를 응답이면 불분명으로 보고 실제 상태로 판정한다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/staff$/);
  const id = uniq();
  const s = { name: `오삼${id}`, phone: "01077778888", email: `svc-${id}@example.com`, password: `pw-${id}-init` };
  // 서버는 처리하고, 응답은 503(코드 없음)으로 바뀐다
  const after503 = async (match: (u: URL) => boolean, method: string, body: { contentType: string; body: string }) => {
    let done = false;
    const pred = (u: URL) => u.pathname.startsWith("/api/seller/staff") && match(u);
    await page.route(pred, async (route) => {
      if (done || route.request().method() !== method) return route.continue();
      done = true;
      await route.fetch();
      return route.fulfill({ status: 503, ...body });
    });
    return () => page.unroute(pred);
  };
  const html = { contentType: "text/html", body: "<html>Service Unavailable</html>" };
  const json503 = { contentType: "application/json", body: JSON.stringify({ error: "service_unavailable" }) };

  // 직원 추가: 503이어도 목록에서 만든 계정을 확인해 성공으로 처리
  await addStaff(page, s);
  let off = await after503((u) => u.pathname === "/api/seller/staff", "POST", json503);
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(page.getByText(`${s.name} 계정을 생성했습니다`, { exact: false })).toBeVisible();
  await off();

  // 비밀번호 재설정: 503(HTML)이면 「변경되었을 수 있음」으로 잠그고 같은 값으로만 재전송
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: `${s.name} 비밀번호 재설정` }).click();
  await dialog.getByLabel("새 비밀번호").fill(`pw-${id}-503`);
  off = await after503((u) => u.pathname.endsWith("/password"), "POST", html);
  await dialog.getByRole("button", { name: "재설정" }).click();
  await expect(dialog.getByTestId("sp-unclear")).toContainText("비밀번호가 변경되었을 수 있습니다.");
  await expect(dialog.getByLabel("새 비밀번호")).toBeDisabled();
  await off();
  await dialog.getByRole("button", { name: "같은 비밀번호로 재전송" }).click();
  await expect(page.getByText(`${s.name} 비밀번호를 변경했습니다`, { exact: false })).toBeVisible();

  // 권한 수정: 형식을 알 수 없는 4xx(오류 코드 없음)도 불분명 → 다시 읽어 저장으로 판정
  await page.getByRole("button", { name: `${s.name} 정보 · 권한 수정` }).click();
  await dialog.getByRole("checkbox", { name: "상품", exact: true }).check();
  let once = false;
  await page.route(
    (u) => u.pathname.endsWith("/permissions"),
    async (route) => {
      if (once) return route.continue();
      once = true;
      await route.fetch();
      return route.fulfill({ status: 400, contentType: "text/html", body: "<html>Bad Request</html>" });
    },
  );
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText(`${s.name} 정보를 저장했습니다`)).toBeVisible();
  await expect(row(page, s.email)).toContainText("상품");

  // 비활성화: 503이어도 다시 읽어 비활성으로 판정
  await page.getByRole("button", { name: `${s.name} 비활성화` }).click();
  off = await after503((u) => u.pathname.endsWith("/disable"), "POST", json503);
  await dialog.getByRole("button", { name: "비활성화" }).click();
  await expect(page.getByText(`${s.name} 계정을 비활성화했습니다`)).toBeVisible();
  await expect(row(page, s.email)).toContainText("비활성");
  await off();
});

test("권한이 하나도 없는 직원도 창으로 돌아오면 대표자가 켠 권한이 메뉴에 나온다(새로고침 없이)", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/staff$/);
  const id = uniq();
  const s = { name: `권한없음${id}`, phone: "01055556666", email: `none-${id}@example.com`, password: `pw-${id}-init` };
  await addStaff(page, s);
  await page.getByRole("button", { name: "계정 생성" }).click();
  await expect(row(page, s.email)).toContainText("켜진 권한 없음");

  const staffPage = await page.context().browser()!.newPage();
  await login(staffPage, s.email, s.password, "/seller/products");
  await skipIdentityLink(staffPage);
  const staffMenu = staffPage.getByRole("complementary", { name: "파트너스 메뉴" });
  await expect(staffMenu.getByRole("link", { name: "주문", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: `${s.name} 정보 · 권한 수정` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: "주문·배송", exact: true }).check();
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 직원 창으로 돌아온다(포커스): 화면을 옮기지 않아도 권한을 다시 읽어 메뉴에 나온다
  const orders = staffMenu.getByRole("link", { name: "주문", exact: true });
  await expect(async () => {
    await staffPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(orders).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await staffPage.close();
});

test("직원: 메뉴에 직원 계정이 없고, 주소로 들어오면 대표자만 볼 수 있다고 안내한다", async ({ page }) => {
  const listed = page.waitForRequest((r) => r.url().endsWith("/api/seller/staff"), { timeout: 3000 }).then(
    () => true,
    () => false,
  );
  await login(page, "demo-staff@example.com", PASSWORD, "/seller/staff");
  await skipIdentityLink(page);
  await expect(page).toHaveURL(/\/seller\/staff$/);
  await expect(page.getByText("대표자만 볼 수 있습니다")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "직원 계정" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "계정 생성" })).toHaveCount(0);
  // 직원 화면은 직원 목록을 부르지 않는다
  expect(await listed).toBe(false);
  await shot(page, "SA-100-staff");
});
