/**
 * 初始化脚本 - 创建管理员账户
 * 运行：node server/init.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db, nextUidSeq, users, apps } = require('./db');

console.log('🔧 初始化数据库...');

// ──────────────────────────────────────────
// 创建超级管理员
// ──────────────────────────────────────────
const ADMIN_EMAIL    = 'xurui@xurui365.top';
const ADMIN_PASSWORD = 'X114514@r';
const ADMIN_NAME     = 'xurui';

const existing = users.findByEmail.get(ADMIN_EMAIL);
if (existing) {
  console.log(`✓ 管理员账户已存在：${ADMIN_EMAIL}`);
} else {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  const seq  = nextUidSeq();
  users.insert.run({
    id:            uuidv4(),
    uid_seq:       seq,
    name:          ADMIN_NAME,
    email:         ADMIN_EMAIL,
    phone:         null,
    password_hash: hash,
    role:          'admin',
    admin_level:   1,
    user_level:    1,
    status:        'active',
  });
  console.log(`✓ 超级管理员创建成功`);
  console.log(`  账号：${ADMIN_EMAIL}`);
  console.log(`  密码：${ADMIN_PASSWORD}`);
  console.log(`  角色：超级管理员 (admin Lv.1)`);
}

// ──────────────────────────────────────────
// 预置环境变量键（空值，待填写）
// ──────────────────────────────────────────
const { env } = require('./db');
const ENV_KEYS = [
  'WECHAT_APP_ID','WECHAT_APP_SECRET','WECHAT_REDIRECT_URI',
  'WECOM_CORP_ID','WECOM_AGENT_ID','WECOM_APP_SECRET','WECOM_REDIRECT_URI',
  'FEISHU_APP_ID','FEISHU_APP_SECRET','FEISHU_REDIRECT_URI',
  'DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','DINGTALK_REDIRECT_URI',
  'DOUYIN_CLIENT_KEY','DOUYIN_CLIENT_SECRET','DOUYIN_REDIRECT_URI',
  'KUAISHOU_APP_ID','KUAISHOU_APP_SECRET','KUAISHOU_REDIRECT_URI',
  'XHS_APP_ID','XHS_APP_SECRET','XHS_REDIRECT_URI',
  'BILIBILI_CLIENT_ID','BILIBILI_CLIENT_SECRET','BILIBILI_REDIRECT_URI',
  'GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI',
  'APPLE_CLIENT_ID','APPLE_TEAM_ID','APPLE_KEY_ID','APPLE_PRIVATE_KEY','APPLE_REDIRECT_URI',
  'VOLCENGINE_ACCESS_KEY_ID','VOLCENGINE_ACCESS_KEY_SECRET','VOLCENGINE_SMS_SIGN','VOLCENGINE_SMS_TEMPLATE_ID',
  'ALIYUN_ACCESS_KEY_ID','ALIYUN_ACCESS_KEY_SECRET','ALIYUN_SMS_SIGN','ALIYUN_SMS_TEMPLATE',
  'TENCENT_SMS_SECRET_ID','TENCENT_SMS_SECRET_KEY','TENCENT_SMS_APP_ID','TENCENT_SMS_SIGN','TENCENT_SMS_TEMPLATE_ID','TENCENT_SMS_REGION',
  'SMS_PROVIDER','SMS_CODE_EXPIRE',
  'ALIYUN_KYC_ACCESS_KEY_ID','ALIYUN_KYC_ACCESS_KEY_SECRET','ALIYUN_KYC_SCENE_ID','ALIYUN_KYC_MODE','ALIYUN_KYC_CALLBACK_URL',
  'VOLC_KYC_ACCESS_KEY_ID','VOLC_KYC_ACCESS_KEY_SECRET','VOLC_KYC_APP_ID','VOLC_KYC_MODE','VOLC_KYC_CALLBACK_URL',
  'TENCENT_KYC_SECRET_ID','TENCENT_KYC_SECRET_KEY','TENCENT_KYC_REGION','TENCENT_KYC_RULE_ID','TENCENT_KYC_CALLBACK_URL',
  'KYC_PROVIDER','KYC_ENABLED','KYC_ALLOW_DELETE',
  'SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASS','SMTP_FROM',
  'JWT_SECRET','JWT_EXPIRES_IN','SESSION_SECRET','EMAIL_CODE_EXPIRE',
  'PORT','BASE_URL','NODE_ENV','CORS_ORIGIN',
];

let envInit = 0;
ENV_KEYS.forEach(k => {
  const existing = env.get.get(k);
  if (!existing) { env.set.run(k, ''); envInit++; }
});
if (envInit > 0) console.log(`✓ 环境变量键预置：${envInit} 条`);

console.log('\n✅ 初始化完成！运行 npm start 启动服务');
process.exit(0);
