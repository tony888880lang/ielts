# 雅思学习任务面板

静态前端网站，使用 Supabase Authentication 和 Postgres 同步学习记录。

## 本地运行

在本目录执行：

```bash
python3 -m http.server 5177
```

然后打开：

```text
http://127.0.0.1:5177/
```

## 部署

将整个 `ielts-study-panel` 目录上传到静态网站服务器即可。需要保留：

- `index.html`
- `styles.css`
- `app.js`
- `cloud.js`
- `data/`
- `assets/audio/`

Nginx、Apache、对象存储静态托管、GitHub Pages、Vercel 或其他静态托管服务均可使用。

## 数据同步

- 未登录时，记录保存在浏览器 `localStorage` 中。
- 使用邮箱登录链接登录后，完整学习状态和生词本会同步到 Supabase。
- 首次登录会在本机和云端记录之间选择较新的版本，并合并生词本。
- 云端临时不可用时仍会保存本机副本，恢复后可点击“立即同步”。

数据库结构和 RLS 策略见 `supabase/ielts_user_state.sql`。
