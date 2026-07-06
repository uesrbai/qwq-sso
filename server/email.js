/**
 * 邮件服务 - 支持 Zeabur Email / SMTP，带轮询机制
 */
const nodemailer = require('nodemailer');
const { pollExecute, getStrategy } = require('./poller');

// ── 邮件 HTML 模板 ──
function buildCodeHtml(code) {
  const expire = Math.round(parseInt(process.env.EMAIL_CODE_EXPIRE || '600') / 60);
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
      <div style="text-align:center;margin-bottom:32px;">
        <div style="width:48px;height:48px;background:#5A8A00;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;">
          <span style="color:white;font-size:24px;">🔐</span>
        </div>
        <h1 style="margin:16px 0 4px;font-size:24px;font-weight:700;color:#111827;">登录验证码</h1>
        <p style="margin:0;color:#6B7280;font-size:14px;">统一账号服务</p>
      </div>
      <div style="background:#F6FFDA;border-radius:12px;padding:32px;text-align:center;margin-bottom:24px;border:1px solid #ECFFAF;">
        <p style="margin:0 0 16px;color:#374151;font-size:15px;">您的验证码是：</p>
        <div style="letter-spacing:12px;font-size:40px;font-weight:800;color:#5A8A00;">${code}</div>
        <p style="margin:16px 0 0;color:#9CA3AF;font-size:13px;">验证码 ${expire} 分钟内有效，请勿泄露给他人。</p>
      </div>
      <p style="color:#9CA3AF;font-size:12px;text-align:center;margin:0;">
        如果您未请求此验证码，请忽略此邮件。<br>此邮件由系统自动发送，请勿回复。
      </p>
    </div>`;
}

// ── Zeabur Email ──
async function sendViaZeabur(to, subject, html) {
  const token = process.env.ZEABUR_EMAIL_TOKEN;
  if (!token) throw new Error('ZEABUR_EMAIL_TOKEN 未配置');

  const from = process.env.ZEABUR_EMAIL_FROM;
  if (!from) {
    throw new Error(
      'ZEABUR_EMAIL_FROM 未配置。请在环境变量中填写发件人地址，' +
      '格式如：noreply@yourproject.zeabur.app（需与 Zeabur Email Service 绑定的域名一致）'
    );
  }

  // 验证 from 地址格式
  if (!from.includes('@') || from === 'noreply@zeabur.app') {
    throw new Error(
      `ZEABUR_EMAIL_FROM="${from}" 格式无效。` +
      '请填写你项目的实际邮件域名，如：noreply@yourproject.zeabur.app'
    );
  }

  const res = await fetch('https://email.zeabur.app/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Zeabur Email 发送失败 (${res.status}): ${errText}\n` +
      `发件人=${from} 收件人=${to}`
    );
  }
  return await res.json();
}

// ── SMTP（通用，支持多账号轮询 SMTP_HOST / SMTP_HOST_2 等）──
function buildTransporter(suffix = '') {
  const host = process.env[`SMTP_HOST${suffix}`];
  if (!host) return null;
  return nodemailer.createTransport({
    host,
    port:   parseInt(process.env[`SMTP_PORT${suffix}`]  || '465'),
    secure: process.env[`SMTP_SECURE${suffix}`] !== 'false',
    auth: {
      user: process.env[`SMTP_USER${suffix}`],
      pass: process.env[`SMTP_PASS${suffix}`],
    },
  });
}

async function sendViaSMTP(to, subject, html, suffix = '') {
  const t = buildTransporter(suffix);
  if (!t) throw new Error(`SMTP${suffix} 未配置`);

  const smtpUser = process.env[`SMTP_USER${suffix}`];
  const smtpFrom = process.env[`SMTP_FROM${suffix}`];

  // 提取纯邮箱地址（去掉 "名称 <email>" 格式的包装）
  function extractEmail(str) {
    if (!str) return null;
    const match = str.match(/<([^>]+)>/);
    return match ? match[1].trim() : str.trim();
  }

  // 优先用 SMTP_FROM 里的纯邮箱，否则用 SMTP_USER
  const from = extractEmail(smtpFrom) || smtpUser;
  if (!from) throw new Error(`SMTP${suffix} 发件人地址未配置`);

  try {
    await t.sendMail({ from, to, subject, html });
  } catch (e) {
    throw new Error(`SMTP${suffix} 发送失败 [from=${from}]: ${e.message}`);
  }
}

// ── 统一发送入口（轮询）──
async function sendEmail(to, subject, html) {
  const e = process.env;
  const strategy = getStrategy('email');

  // 按配置组装服务商列表
  const providers = [
    {
      key: 'email_zeabur',
      available: !!e.ZEABUR_EMAIL_TOKEN,
      fn: () => sendViaZeabur(to, subject, html),
    },
    {
      key: 'email_smtp',
      available: !!e.SMTP_HOST,
      fn: () => sendViaSMTP(to, subject, html, ''),
    },
    {
      key: 'email_smtp2',
      available: !!e.SMTP_HOST_2,
      fn: () => sendViaSMTP(to, subject, html, '_2'),
    },
    {
      key: 'email_smtp3',
      available: !!e.SMTP_HOST_3,
      fn: () => sendViaSMTP(to, subject, html, '_3'),
    },
  ];

  const { provider } = await pollExecute(providers, strategy);
  console.log(`[Email] ${to} ← ${provider} (strategy:${strategy})`);
}

async function sendEmailCode(email, code) {
  const subject = `【登录验证码】${code}`;
  return sendEmail(email, subject, buildCodeHtml(code));
}

module.exports = { sendEmailCode, sendEmail };
