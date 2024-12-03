# koishi-plugin-message-blocker

[![npm](https://img.shields.io/npm/v/koishi-plugin-message-blocker?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-message-blocker)

可以设置违禁词、违禁图等，监听到后可选择撤回、禁言、警告等。违禁图的原理是感知哈希，支持相似度

## 帮助

![](https://Jin1c-3.github.io/picx-images-hosting/图片.2rv6fxq6s9.webp)

## 添加图片规则

使用换行可以添加多张图片

![](https://Jin1c-3.github.io/picx-images-hosting/图片.73tznha7mr.webp)

## 添加文本规则

参数是 2 表示正则规则，参数是 1 表示普通文本规则

![](https://Jin1c-3.github.io/picx-images-hosting/图片.7zqh2xlvji.webp)

可以看到普通群员的发言被撤回

## 删除规则

![](https://Jin1c-3.github.io/picx-images-hosting/图片.7p3n9s5ddx.webp)

存储在本地的图片有删除逻辑，无需考虑存储占用

## 查看规则

![](https://Jin1c-3.github.io/picx-images-hosting/图片.45q5ky9ae.webp)

配置中可选每一页的数量，参数可以跟查看第 x 页
