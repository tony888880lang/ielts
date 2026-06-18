# 雅思学习任务面板

纯前端静态网站，不需要数据库或构建工具。

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
- `data/`
- `assets/audio/`

Nginx、Apache、对象存储静态托管、GitHub Pages 或其他静态托管服务均可使用。

学习进度保存在浏览器 `localStorage` 中。更换浏览器、清理浏览器数据或更换域名后，原进度不会自动迁移。
