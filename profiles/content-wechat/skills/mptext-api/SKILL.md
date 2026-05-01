---
name: mptext-api
description: >-
  Use when the user wants to search WeChat public accounts, fetch article
  lists, download article content in html/markdown/text/json, or query account
  metadata via the mptext.top API. Triggers include "公众号", "微信文章",
  "mptext", "下载文章", "搜索公众号", "文章导出", "WeChat article", and
  "公众号查询".
---

# mptext-api

公众号文章导出 API (https://down.mptext.top) — 微信公众号文章搜索、列表获取、内容下载、主体信息查询。

## 认证

**需要密钥的接口**（1-3, 6）：通过以下任一方式传递：
- 请求头：`X-Auth-Key: <密钥>`
- Cookie：`auth-key=<密钥>`

**无需密钥的接口**（4-5）：`/api/public/v1/download` 和 `/api/public/beta/authorinfo`

密钥与网站登录绑定，扫码登录后自动刷新。登录失效后密钥也失效。

## 接口列表

### 1. 搜索公众号
```
GET https://down.mptext.top/api/public/v1/account
```
| 参数 | 位置 | 必填 | 默认值 | 类型 | 说明 |
|------|------|------|--------|------|------|
| keyword | query | 是 | — | String | 搜索关键字 |
| begin | query | 否 | 0 | Int | 起始下标（从0开始，不能为负） |
| size | query | 否 | 5 | Int | 返回条数（最大20） |

**需要认证**

---

### 2. 根据文章链接查询公众号
```
GET https://down.mptext.top/api/public/v1/accountbyurl
```
| 参数 | 位置 | 必填 | 默认值 | 类型 | 说明 |
|------|------|------|------|------|------|
| url | query | 是 | — | String | 文章链接 |

**需要认证**

---

### 3. 获取公众号历史文章列表
```
GET https://down.mptext.top/api/public/v1/article
```
| 参数 | 位置 | 必填 | 默认值 | 类型 | 说明 |
|------|------|------|------|------|------|
| fakeid | query | 是 | — | String | 公众号id |
| begin | query | 否 | 0 | Int | 起始下标（从0开始，不能为负） |
| size | query | 否 | 5 | Int | 返回消息条数（最大20） |

一条消息可能包含多篇文章。

**需要认证**

---

### 4. 获取文章内容
```
GET https://down.mptext.top/api/public/v1/download
```
| 参数 | 位置 | 必填 | 默认值 | 类型 | 说明 |
|------|------|------|------|------|------|
| url | query | 是 | — | String | 文章链接（需URL编码） |
| format | query | 否 | html | String | 输出格式：html / markdown / text / json |

**无需认证**

---

### 5. 查询公众号主体信息 (beta)
```
GET https://down.mptext.top/api/public/beta/authorinfo
```
| 参数 | 位置 | 必填 | 默认值 | 类型 | 说明 |
|------|------|------|------|------|------|
| fakeid | query | 是 | — | String | 公众号id |

**无需认证**

---

### 6. 查询公众号主体信息 (beta)
```
GET https://down.mptext.top/api/public/beta/aboutbiz
```
| 参数 | 位置 | 必填 | 默认值 | 类型 | 说明 |
|------|------|------|------|------|------|
| fakeid | query | 是 | — | String | 公众号id |
| key | query | 否 | — | String | 微信抓包获取的 x-wechat-key 参数 |

**需要认证**

---

## 常用工作流

### 下载文章为 Markdown
1. 用接口1搜索公众号获取 fakeid，或用接口2通过文章URL获取 fakeid
2. 用接口4下载文章，`format=markdown`，URL需URL编码

```bash
# 示例：下载文章
curl -G "https://down.mptext.top/api/public/v1/download" \
  -d "url=$(python3 -c "import urllib.parse; print(urllib.parse.quote('https://mp.weixin.qq.com/s/xxxx'))")" \
  -d "format=markdown"
```

### 批量获取公众号文章列表
1. 用接口1搜索公众号获取 fakeid
2. 用接口3分页获取文章列表，`begin` 和 `size` 控制分页
3. 用接口4批量下载文章内容

### 通过 Claude Code 调用
使用 Bash 工具执行 curl 请求。URL 参数中包含 `&` 时需用双引号包裹整个 URL。

```bash
AUTH_KEY="你的密钥"
ARTICLE_URL="https://mp.weixin.qq.com/s/xxxx"

# 下载为 markdown
curl -s -G "https://down.mptext.top/api/public/v1/download" \
  -H "X-Auth-Key: $AUTH_KEY" \
  --data-urlencode "url=$ARTICLE_URL" \
  -d "format=markdown"
```

## 注意事项

- 调用量较大时推荐私有部署
- API 目前免费，后续可能改为收费
- `format=markdown` 可直接用于 LLM 处理和知识库导入
- 密钥随网站登录刷新，长期使用需定期重新登录
- 文章内容下载接口无需认证，便于公开文章的高速获取
