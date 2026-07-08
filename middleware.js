// Vercel Edge Middleware — HTTP Basic Auth
// 保護整個網站（含 data/*.json 資料檔），未輸入正確帳密一律回 401。
//
// 設定方式（部署後才會生效）：
//   Vercel 專案 → Settings → Environment Variables → 新增：
//     BASIC_AUTH_USER = 你想要的帳號
//     BASIC_AUTH_PASS = 你想要的密碼
//   存好後到 Deployments 重新部署一次（或等下次 push 自動部署）。
//
// 安全預設：環境變數沒設定時，一律擋下所有請求（fail-closed），
// 避免忘記設定密碼卻讓網站繼續公開。

export default function middleware(request) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;

  const unauthorized = () =>
    new Response('請輸入帳號密碼', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Secure Area", charset="UTF-8"' },
    });

  if (!user || !pass) return unauthorized();  // 尚未設定密碼 → 一律擋下

  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Basic ')) return unauthorized();

  try {
    const decoded = atob(auth.slice(6));
    const sep = decoded.indexOf(':');
    const u = decoded.slice(0, sep);
    const p = decoded.slice(sep + 1);
    if (u === user && p === pass) return;  // 通過，繼續正常回應
  } catch (e) {}

  return unauthorized();
}

export const config = {
  matcher: '/:path*',
};
