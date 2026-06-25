/**
 * 邮件服务 - 发送验证码 / 登录链接
 */
const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.qq.com',
      port: parseInt(process.env.SMTP_PORT || '465'),
      secure: process.env.SMTP_SECURE !== 'false',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

async function sendEmailCode(email, code) {
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <div style="width: 48px; height: 48px; background: #4F46E5; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center;">
          <span style="color: white; font-size: 24px;">🔐</span>
        </div>
        <h1 style="margin: 16px 0 4px; font-size: 24px; font-weight: 700; color: #111827;">登录验证码</h1>
        <p style="margin: 0; color: #6B7280; font-size: 14px;">统一登录系统</p>
      </div>
      
      <div style="background: #F9FAFB; border-radius: 12px; padding: 32px; text-align: center; margin-bottom: 24px;">
        <p style="margin: 0 0 16px; color: #374151; font-size: 15px;">您的验证码是：</p>
        <div style="letter-spacing: 12px; font-size: 40px; font-weight: 800; color: #4F46E5; font-variant-numeric: tabular-nums;">${code}</div>
        <p style="margin: 16px 0 0; color: #9CA3AF; font-size: 13px;">验证码 ${Math.round(parseInt(process.env.EMAIL_CODE_EXPIRE || '600') / 60)} 分钟内有效，请勿泄露给他人。</p>
      </div>
      
      <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0;">
        如果您未请求此验证码，请忽略此邮件。<br>
        此邮件由系统自动发送，请勿回复。
      </p>
    </div>
  `;

  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || `"统一登录系统" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `【登录验证码】${code}`,
    html,
  });

  console.log(`[Email] 验证码已发送至 ${email}`);
  return true;
}

module.exports = { sendEmailCode };
