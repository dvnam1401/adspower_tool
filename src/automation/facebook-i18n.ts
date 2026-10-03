// Multi-language phrase tokens for the Facebook login state machine.
// Languages: EN, VI, PT-BR, ES, ZH-CN. Tokens are lowercase substrings.
//
// Single source of truth for every LOCALE-DEPENDENT text-match site in
// `facebook-login.ts`. Structural decisions (cookie-authoritative login,
// URL classification, iframe captcha, geometric soft-checkpoint button)
// stay in the state machine and NEVER gate on these tokens — an unmatched
// text token degrades gracefully to the existing structural path, never to
// a false login-success. Lines marked `// ⚠verify` are seed guesses to be
// confirmed against captured fixtures/live renders (append-only if wrong).

/** Host-side: true if any token is a substring of text (case-insensitive). */
export function matchesAnyToken(text: string | null | undefined, tokens: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return tokens.some(t => lower.includes(t));
}

/** Build a comma-joined Playwright selector: tag:has-text("tok") for each tag×token. */
export function hasTextSelector(tags: string[], tokens: string[]): string {
  const parts: string[] = [];
  for (const tag of tags) for (const tok of tokens) parts.push(`${tag}:has-text("${tok.replace(/"/g, '\\"')}")`);
  return parts.join(', ');
}

/** Build a comma-joined attribute-substring selector: [attr*="tok" i] for each token. */
export function attrContainsSelector(attr: string, tokens: string[]): string {
  return tokens.map(tok => `[${attr}*="${tok.replace(/"/g, '\\"')}" i]`).join(', ');
}

export const WRONG_PASSWORD_TOKENS = [
  'incorrect password', 'wrong password',
  "password that you've entered is incorrect", 'password that you’ve entered is incorrect',
  'password you entered is incorrect',
  'mật khẩu bạn đã nhập không chính xác', 'mật khẩu không chính xác', 'sai mật khẩu',
  'senha inserida está incorreta', 'senha incorreta', 'senha que você digitou está incorreta',
  'contraseña que ingresaste es incorrecta', 'contraseña incorrecta',
  '密码不正确', '密码错误', '您输入的密码不正确', // ⚠verify
];

export const ACCOUNT_NOT_FOUND_TOKENS = [
  "the email or mobile number you entered isn't connected to an account",
  'the email or mobile number you entered isn’t connected to an account',
  'the email address or mobile number you entered isn’t connected to an account',
  'the email you’ve entered doesn’t match any account',
  'email hoặc số di động bạn nhập không kết nối với tài khoản nào', 'tài khoản không tồn tại',
  'o email ou celular informado não está associado a nenhuma conta',
  'el correo electrónico o número de celular que ingresaste no está conectado a ninguna cuenta',
  '你输入的邮箱或手机号未关联任何账户', // ⚠verify
];

export const HUMAN_VERIFICATION_TOKENS = [
  "confirm that you're human", 'confirm that you are human', 'confirm that you’re human',
  'confirm that you’re human to use your profile',
  // FB variant WITHOUT "that": "…, confirm you're human to use your profile" (observed live).
  "confirm you're human", 'confirm you’re human', 'confirm you are human',
  "confirm you're human to use your profile", 'confirm you’re human to use your profile',
  'xác nhận bạn là người thật', 'xác minh bạn là con người', 'xác nhận bạn là người',
  'confirme que você é humano',
  'confirma que eres una persona', 'confirma que eres humano',
  '确认你是真人', '确认您是真人', // ⚠verify
];

export const ACCOUNT_LOCKED_TOKENS = [
  'your account has been locked', 'your account has been disabled', 'we suspended your account',
  'tài khoản của bạn đã bị khóa', 'tài khoản của bạn đã bị tạm ngưng', 'tài khoản của bạn đã bị vô hiệu hóa',
  'sua conta foi bloqueada', 'sua conta foi desativada', 'suspenderemos sua conta',
  'tu cuenta ha sido bloqueada', 'tu cuenta ha sido inhabilitada', 'suspendimos tu cuenta',
  '你的账户已被锁定', '你的账户已被停用', // ⚠verify
];

export const IDENTITY_VERIFICATION_TOKENS = [
  'upload your id', 'confirm your identity', "help us confirm it's you", 'send code via sms',
  'tải lên giấy tờ tùy thân', 'xác nhận danh tính', 'gửi mã qua sms',
  'carregar documento de identidade', 'confirme sua identidade',
  'sube tu identificación', 'confirma tu identidad', 'enviar código por sms',
  '上传您的身份证件', '确认您的身份', // ⚠verify
];

export const CAPTCHA_HINT_TOKENS = ['select', 'puzzle', 'audio', 'chọn', 'selecione', 'seleccione', '选择', '拼图']; // ⚠verify zh
export const RECAPTCHA_TEXT_TOKENS = ["i'm not a robot", 'không phải là người máy', 'não sou um robô', 'no soy un robot', '我不是机器人']; // ⚠verify zh

export const LOGGED_OUT_TOKENS = [
  'log in or sign up for facebook', 'hãy đăng nhập hoặc đăng ký facebook',
  'entrar ou cadastrar-se no facebook', 'iniciar sesión o registrarte en facebook', '登录或注册facebook', // ⚠verify zh
];

// aria-label / placeholder substrings proving a logged-in chrome is present (secondary to cookie).
export const LOGGED_IN_ARIA_TOKENS = [
  'your profile', 'trang cá nhân của bạn', 'seu perfil', 'tu perfil', '你的主页', // ⚠verify zh
  'account', 'tài khoản', 'conta', 'cuenta', '账户', // ⚠verify zh
  'search facebook', 'tìm kiếm trên facebook', 'pesquisar no facebook', 'buscar en facebook', '搜索facebook', // ⚠verify zh
  'messenger', 'notifications', 'thông báo', 'notificações', 'notificaciones', '通知', // ⚠verify zh
];

// Placeholder substrings for the "Search Facebook" box (secondary logged-in evidence).
export const SEARCH_PLACEHOLDER_TOKENS = [
  'search facebook', 'tìm kiếm trên facebook', 'pesquisar no facebook', 'buscar en facebook', '搜索facebook', // ⚠verify zh
];

// aria-label substrings for the account/profile chrome button (structural UI-state hint).
export const ACCOUNT_ARIA_TOKENS = ['account', 'tài khoản', 'conta', 'cuenta', '账户']; // ⚠verify zh

// aria-label substrings for a dialog close ("X") button.
export const CLOSE_ARIA_TOKENS = ['đóng', 'close', 'cerrar', 'fechar', '关闭']; // ⚠verify zh

export const DISMISS_POPUP_TOKENS = [
  'dismiss', 'bỏ qua', 'huỷ', 'hủy', 'cancel', 'chặn', 'block', 'không cho phép', 'lúc khác',
  'not now', 'agora não', 'close', 'đóng', 'fechar',
  'cho phép tất cả cookie', 'allow all cookies', 'aceitar todos os cookies',
  'ahora no', 'cerrar', 'cancelar', 'permitir todas las cookies',
  '关闭', '取消', '暂时不', '允许所有 cookie', // ⚠verify zh
];

export const SUSPECT_DISMISS_TOKENS = ['dismiss', 'bỏ qua', 'descartar', '忽略']; // ⚠verify zh
export const TRUST_DEVICE_TOKENS = ['trust this device', 'lưu trình duyệt', 'salvar navegador', 'confiar en este dispositivo', '信任此设备']; // ⚠verify zh
export const SAVE_LOGIN_TOKENS = ['save', 'lưu', 'salvar', 'guardar', '保存']; // ⚠verify zh
export const CONTINUE_TOKENS = ['continue', 'tiếp tục', 'continuar', 'avançar', '继续', '下一步']; // ⚠verify zh
export const TRY_ANOTHER_WAY_TOKENS = ['try another way', 'thử cách khác', 'tente de outra forma', 'prueba otra forma', 'probar otra forma', '尝试其他方式']; // ⚠verify zh
export const AUTH_APP_TOKENS = [
  'authentication app', 'get a code from your authentication app', 'ứng dụng xác thực',
  'app de autenticação', 'aplicación de autenticación', '身份验证应用', '验证器应用', // ⚠verify zh
];
export const CHOOSE_METHOD_TOKENS = [
  'choose a way', 'available confirmation methods', 'get a code from your authentication app',
  'chọn cách xác nhận', 'escolha uma forma', 'elige una forma', '选择一种方式', // ⚠verify zh
];
export const DEVICE_NOTIFICATION_TOKENS = [
  'check your notifications on another device', 'waiting for approval',
  'kiểm tra thông báo trên thiết bị khác', 'verifique as notificações em outro dispositivo',
  'revisa tus notificaciones en otro dispositivo', '在另一台设备上查看通知', // ⚠verify zh
];
export const GO_TO_AUTH_APP_TOKENS = [
  'go to your authentication app', 'đến ứng dụng xác thực', 'acesse seu app de autenticação',
  've a tu aplicación de autenticación', '打开身份验证应用', // ⚠verify zh
];
export const TWO_FA_REJECTED_TOKENS = [
  'incorrect', 'invalid', 'expired', 'wrong', 'didn', 'wasn',
  'sai', 'không đúng', 'hết hạn', 'incorreto', 'expirado', 'inválido', 'errado',
  'incorrecto', 'caducado', 'no válido', '不正确', '无效', '已过期', // ⚠verify zh
];
export const RELOAD_PAGE_TOKENS = ['reload page', 'tải lại trang', 'recarregar', 'recargar', '重新加载']; // ⚠verify zh
export const ONE_TAP_CANCEL_TOKENS = ['cancel', 'huỷ', 'hủy', 'cancelar', '取消']; // ⚠verify zh
export const LOGIN_BUTTON_TOKENS = ['log in', 'đăng nhập', 'entrar', 'iniciar sesión', '登录']; // ⚠verify zh

// 2FA session/context expiry dialog (Ảnh: "Phiên của bạn đã hết thời gian chờ / Vui lòng bắt đầu lại").
// The encrypted_context of the two_factor flow died; the notification screen underneath is dead too.
export const SESSION_TIMEOUT_TOKENS = [
  'session has timed out', 'session timed out', 'please start again',
  'phiên của bạn đã hết thời gian chờ', 'hết thời gian chờ', 'vui lòng bắt đầu lại',
  'sua sessão expirou', 'tempo esgotado', 'tu sesión ha expirado', 'inténtalo de nuevo', '会话已超时', '请重新开始', // ⚠verify zh
];
// OK / restart button on the session-timeout dialog.
export const RESTART_OK_TOKENS = ['ok', 'bắt đầu lại', 'start again', 'começar de novo', 'empezar de nuevo', '确定', '重新开始']; // ⚠verify zh
