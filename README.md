# 雅思学习任务面板

静态前端网站，使用 Supabase Postgres 自动同步学习记录。

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

- 打开网站后会自动读取并保存同一份 Supabase 共享状态，无需登录。
- 首次连接会在本机和云端记录之间选择较新的版本；新设备没有本地记录时始终使用云端版本。
- 合并状态时会保留两端生词本和写作档案中的全部条目。
- 云端临时不可用时仍会保存本机副本，恢复后可点击“立即同步”。
- 这是单用户模式，任何知道网站地址的人理论上都能修改共享记录。

数据库结构和 RLS 策略见 `supabase/ielts_shared_state.sql`。

## 资料库

- “口语材料库”集中浏览 18 篇口语短文、MP3、必背表达和替换练习。
- 写作任务需要上传“我的作文”和“范文”后才能完成，完成时自动形成写作档案。
- 写作文件存放在 Supabase Storage，配置见 `supabase/ielts_writing_storage.sql`。
