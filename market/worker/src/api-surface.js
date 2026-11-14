/**
 * Single description authority for the worker's HTTP API.
 *
 * The router in `index.js` decides what is served; this table decides what is
 * described. `openapi.js` builds /openapi.json from it, `api-doc.js` renders
 * the human page from it, and `scripts/market-worker.test.mjs` fails when a
 * path the router serves has no entry here.
 *
 * `doc` and `status` are the curated Chinese prose and status column of the
 * human page; `operation` is the OpenAPI operation object minus `summary`.
 */
export const API_ROUTES = [
  {
    "method": "GET",
    "path": "/api",
    "summary": "API service information",
    "doc": "API 服务信息与目录链接",
    "status": "200",
    "operation": {
      "responses": {
        "200": {
          "description": "Service info and catalog link"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/health",
    "summary": "Health check",
    "doc": "健康检查，返回 <code>{ \"ok\": true }</code>",
    "status": "200",
    "operation": {
      "responses": {
        "200": {
          "description": "Alive"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/stats",
    "summary": "Vote counts per kind and asset id; edge-cached one minute and served from the last good counts under storage failures",
    "doc": "每类（skin / pet / plugin / preset）每个资产的投票数与安装数；边缘缓存 1 分钟，D1 故障时回退最近一次成功计数",
    "status": "200 / 503",
    "operation": {
      "responses": {
        "200": {
          "description": "Vote counts and install counts"
        },
        "503": {
          "description": "Storage unavailable (D1 overloaded) and no cached copy; cards fall back to their zero state"
        }
      }
    }
  },
  {
    "method": "POST",
    "path": "/api/install",
    "summary": "Record one successful Workshop install (skins, pets, community plugins or presets); one event per install, Turnstile-gated",
    "doc": "记录一次成功的创意工坊安装（皮肤 / 宠物 / 插件 / 预设），Turnstile 校验；字段：<code>kind</code>、<code>asset_id</code>、<code>device_fp</code>、<code>install_id</code>、<code>turnstile_token</code>（资产须为已发布 manifest 成员，正文上限 4 KiB）",
    "status": "200 / 400 / 403 / 413",
    "operation": {
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": [
                "kind",
                "asset_id",
                "device_fp",
                "install_id",
                "turnstile_token"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "skin",
                    "pet",
                    "plugin",
                    "preset"
                  ]
                },
                "asset_id": {
                  "type": "string"
                },
                "device_fp": {
                  "type": "string"
                },
                "install_id": {
                  "type": "string"
                },
                "turnstile_token": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Install recorded; returns the refreshed cumulative install count"
        },
        "400": {
          "description": "Invalid parameters or JSON, or asset_id not in the published manifests (unknown-asset)"
        },
        "403": {
          "description": "Turnstile challenge missing or invalid"
        },
        "413": {
          "description": "Body exceeds the 4 KiB write cap (payload-too-large)"
        }
      }
    }
  },
  {
    "method": "POST",
    "path": "/api/like",
    "summary": "Like or unlike an asset (one vote per device, Turnstile-gated)",
    "doc": "点赞 / 取消点赞（每设备一票，Turnstile 校验；资产须为已发布 manifest 成员，正文上限 4 KiB），字段：<code>kind</code>、<code>asset_id</code>、<code>device_fp</code>、<code>turnstile_token</code>、<code>unlike</code>",
    "status": "200 / 400 / 403 / 413",
    "operation": {
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": [
                "kind",
                "asset_id",
                "device_fp"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "skin",
                    "pet",
                    "plugin",
                    "preset"
                  ]
                },
                "asset_id": {
                  "type": "string"
                },
                "device_fp": {
                  "type": "string"
                },
                "turnstile_token": {
                  "type": "string"
                },
                "unlike": {
                  "type": "boolean"
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Like recorded; returns ok, liked and votes"
        },
        "400": {
          "description": "Invalid parameters or JSON, or asset_id not in the published manifests (unknown-asset)"
        },
        "403": {
          "description": "Turnstile verification failed"
        },
        "413": {
          "description": "Body exceeds the 4 KiB write cap (payload-too-large)"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/turnstile/challenge",
    "summary": "Turnstile challenge page for the market card",
    "doc": "供市场卡片使用的 Turnstile 挑战页面",
    "status": "200",
    "operation": {
      "responses": {
        "200": {
          "description": "HTML challenge page"
        }
      }
    }
  },
  {
    "method": "POST",
    "path": "/api/telemetry/event",
    "summary": "Record one anonymous usage event (site pageview or plugin heartbeat)",
    "doc": "匿名使用统计上报（站点 pageview / 插件心跳，条目含 name/version/channel））。仅存储客户端随机 ID 的加盐哈希、UTC 日期与条目名，不存 IP；正文上限 16 KiB",
    "status": "200 / 400 / 413 / 503",
    "operation": {
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": [
                "kind",
                "visitor"
              ],
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "pageview",
                    "heartbeat"
                  ]
                },
                "visitor": {
                  "type": "string",
                  "description": "Random client-generated id; hashed with a server salt before storage"
                },
                "path": {
                  "type": "string",
                  "description": "Site path, pageview kind only"
                },
                "items": {
                  "type": "array",
                  "description": "Reported package names, heartbeat kind only",
                  "items": {
                    "type": "object",
                    "required": [
                      "name"
                    ],
                    "properties": {
                      "name": {
                        "type": "string",
                        "description": "Package name or asset id (e.g. skin:harbor)"
                      },
                      "version": {
                        "type": "string"
                      },
                      "channel": {
                        "type": "string",
                        "enum": [
                          "market",
                          "npm",
                          "unknown"
                        ],
                        "description": "Install channel hint when determinable"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Event accepted (duplicates collapse per day)"
        },
        "400": {
          "description": "Invalid parameters or JSON"
        },
        "413": {
          "description": "Body exceeds the 16 KiB telemetry cap (payload-too-large)"
        },
        "503": {
          "description": "Storage unavailable (D1 overloaded); retry on a later mount"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/telemetry/summary",
    "summary": "Aggregate UV/PV summary; counts only, never raw events",
    "doc": "UV/PV 聚合摘要（仅计数，永不暴露原始事件）。聚合由按日滚存表提供（cron 每 tick 重写今天与昨天并回填缺日，单次聚合量是「天数 × 条目数」，不随事件表增长），结果再由按窗口的汇总缓存提供（cron 轮转预热并按需刷新；30 天内窗口最多滞后 30 分钟，90/365 天窗口最多 12 小时；实时聚合失败或窗口内仍有未回填日期时回退上一份缓存）。日序列为每日去重计数；期间活跃、渠道与版本分布为各日去重计数之和。热门路径与心跳条目支持分页：<code>paths_limit</code>/<code>paths_offset</code>（总量见 <code>site.paths_total</code>）与 <code>items_limit</code>/<code>items_offset</code>（总量见 <code>plugins.totals.items</code>）。配置 <code>TELEMETRY_READ_KEY</code> 后需携带 <code>x-telemetry-key</code> 头（不接受 URL 参数，避免密钥落入日志与浏览器历史）",
    "status": "200 / 403 / 503",
    "operation": {
      "description": "Served from per-UTC-day rollup tables that the cron trigger rewrites and backfills; aggregation cost is days x catalog, not days x events. The daily series is an exact per-day distinct count, while interval item, channel and version numbers are the sum of the per-day distinct counts (a window-wide DISTINCT would need every day's visitor set in memory). Windows up to 30 days can lag 30 minutes, 90/365-day windows up to 12 hours; a stale cached window is served when the live aggregation cannot run, and a window whose days are still being backfilled keeps the previous cache row instead of a short series. Each payload carries generated_at (epoch ms when the rollup was computed) and degraded (labels of auxiliary breakdowns skipped: \"channels\" / \"versions\").",
      "parameters": [
        {
          "name": "x-telemetry-key",
          "in": "header",
          "required": false,
          "schema": {
            "type": "string"
          },
          "description": "Required when TELEMETRY_READ_KEY is configured; the key is never accepted as a URL query parameter"
        },
        {
          "name": "days",
          "in": "query",
          "required": false,
          "schema": {
            "type": "integer",
            "minimum": 1,
            "maximum": 365
          }
        },
        {
          "name": "paths_limit",
          "in": "query",
          "required": false,
          "schema": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "default": 20
          },
          "description": "Hot-path page size"
        },
        {
          "name": "paths_offset",
          "in": "query",
          "required": false,
          "schema": {
            "type": "integer",
            "minimum": 0,
            "default": 0
          },
          "description": "Hot-path page offset; the full count is site.paths_total"
        },
        {
          "name": "items_limit",
          "in": "query",
          "required": false,
          "schema": {
            "type": "integer",
            "minimum": 1,
            "maximum": 200,
            "default": 200
          },
          "description": "Heartbeat-item page size"
        },
        {
          "name": "items_offset",
          "in": "query",
          "required": false,
          "schema": {
            "type": "integer",
            "minimum": 0,
            "default": 0
          },
          "description": "Heartbeat-item page offset; the full count is plugins.totals.items"
        }
      ],
      "responses": {
        "200": {
          "description": "Per-day and per-item aggregates for site pageviews and plugin heartbeats; hot paths and items are paginated, totals included"
        },
        "403": {
          "description": "TELEMETRY_READ_KEY configured and not presented"
        },
        "503": {
          "description": "Storage unavailable (D1 overloaded); retry later"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/npm-badge/downloads",
    "summary": "Shields endpoint badge: monthly npm downloads summed over the current and legacy aggregate package names",
    "doc": "Shields 端点徽章：聚合包新旧两个 npm 名的月下载量合计",
    "status": "200",
    "operation": {
      "responses": {
        "200": {
          "description": "Shields endpoint schema (schemaVersion 1)"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/npm-badge/version",
    "summary": "Shields endpoint badge: latest aggregate version across the current and legacy package names",
    "doc": "Shields 端点徽章：聚合包新旧两个 npm 名中的最新版本",
    "status": "200",
    "operation": {
      "responses": {
        "200": {
          "description": "Shields endpoint schema (schemaVersion 1)"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/npm-badge/total",
    "summary": "Shields endpoint badge: all-time cumulative downloads summed over every published family package (both aggregate names and retired names included) across npm, the npmmirror registry, and GitHub release assets",
    "doc": "Shields 端点徽章：全部已发布家族包（含新旧聚合包名与已退役包名）的全渠道累计下载量合计：npm 官方源 + npmmirror 镜像源 + GitHub Releases 附件",
    "status": "200",
    "operation": {
      "responses": {
        "200": {
          "description": "Shields endpoint schema (schemaVersion 1)"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/npm-downloads",
    "summary": "Last-30d npm downloads for every npm-backed plugin in the served manifest; npm registry public data, not Workshop install counts",
    "doc": "清单内每个带 npm 包名的插件近 30 天 npm 下载量（npm 公开口径，非工坊安装量）",
    "status": "200 / 503",
    "operation": {
      "responses": {
        "200": {
          "description": "JSON map of npm package name to last-30d download count"
        },
        "503": {
          "description": "Plugin manifest unreadable"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/telemetry/badge/users",
    "summary": "Shields endpoint badge: all-time distinct heartbeat visitors (anonymous install count); aggregate only, no key required; served from a cron-precomputed D1 row plus a 30 min edge cache, falling back to the last good count under storage failures",
    "doc": "Shields 端点徽章：匿名心跳的全量去重实例数（用户数），仅聚合计数，无需密钥；读 cron 预计算的单行缓存并经边缘缓存 30 分钟，D1 故障时回退最近一次成功计数",
    "status": "200",
    "operation": {
      "responses": {
        "200": {
          "description": "Shields endpoint schema (schemaVersion 1)"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/skin-center/v2/skins/{skinId}/{asset}",
    "summary": "Skin asset (stylesheet, patches, hooks.mjs, assets/*, preview/*)",
    "doc": "皮肤资产：<code>stylesheet</code>、<code>patches</code>、<code>hooks.mjs</code>、<code>assets/*</code>、<code>preview/*</code>",
    "status": "200 / 404",
    "operation": {
      "parameters": [
        {
          "name": "skinId",
          "in": "path",
          "required": true,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "asset",
          "in": "path",
          "required": true,
          "schema": {
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "description": "Skin asset"
        },
        "404": {
          "description": "Skin or asset not found"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/asset-attest",
    "summary": "Asset provenance attestation for one published asset id",
    "doc": "资产来源证明：按 manifest 中的资产标识返回来源校验信息",
    "status": "200 / 400 / 404",
    "operation": {
      "responses": {
        "200": {
          "description": "Attestation payload for the asset"
        },
        "400": {
          "description": "Missing or malformed asset id"
        },
        "404": {
          "description": "Asset is not a published manifest member"
        }
      }
    }
  },
  {
    "method": "POST",
    "path": "/api/install-batch",
    "summary": "Record one Workshop install covering a bounded set of asset ids; Turnstile-gated",
    "doc": "一次创意工坊安装覆盖一批资产标识（上限见 <code>MAX_INSTALL_BATCH</code>）；Turnstile 校验，字段：<code>kind</code>、<code>device_fp</code>、<code>install_id</code>、<code>asset_ids</code>、<code>turnstile_token</code>",
    "status": "200 / 400 / 403 / 413",
    "operation": {
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": [
                "kind",
                "device_fp",
                "install_id",
                "asset_ids",
                "turnstile_token"
              ],
              "properties": {
                "kind": {
                  "type": "string"
                },
                "device_fp": {
                  "type": "string"
                },
                "install_id": {
                  "type": "string"
                },
                "asset_ids": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "turnstile_token": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Installs recorded"
        },
        "400": {
          "description": "Malformed body or too many assets"
        },
        "403": {
          "description": "Turnstile verification failed"
        },
        "413": {
          "description": "Body above the write cap"
        }
      }
    }
  },
  {
    "method": "PUT",
    "path": "/api/relay/register",
    "summary": "Register one stable-hostname relay id owned by the calling device",
    "doc": "注册一个固定域名中继 id（owner 由配对设备指纹声明）",
    "status": "200 / 400 / 405",
    "operation": {
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": [
                "id"
              ],
              "properties": {
                "id": {
                  "type": "string"
                },
                "owner": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Relay id registered"
        },
        "400": {
          "description": "Invalid JSON or missing id"
        },
        "405": {
          "description": "Wrong method"
        }
      }
    }
  },
  {
    "method": "POST",
    "path": "/api/relay/unregister",
    "summary": "Release a relay id registered by the calling device",
    "doc": "释放本设备注册的中继 id",
    "status": "200 / 400 / 405",
    "operation": {
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": [
                "id"
              ],
              "properties": {
                "id": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Relay id released"
        },
        "400": {
          "description": "Invalid JSON or missing id"
        },
        "405": {
          "description": "Wrong method"
        }
      }
    }
  },
  {
    "method": "PUT",
    "path": "/api/relay/claim",
    "summary": "Claim one relay lease for an instance and report its transport mode",
    "doc": "为实例申领租约（隧道、ingress、CNAME）并回报该实例的传输模式",
    "status": "200 / 400 / 403 / 405 / 429 / 502 / 503",
    "operation": {
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": [
                "id",
                "secret",
                "origin"
              ],
              "properties": {
                "id": {
                  "type": "string"
                },
                "secret": {
                  "type": "string"
                },
                "new_secret": {
                  "type": "string"
                },
                "origin": {
                  "type": "object"
                },
                "plugin": {
                  "type": "object"
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Lease converged: mode, tunnel token, hostname and the bridge endpoint"
        },
        "400": {
          "description": "Invalid JSON or parameters"
        },
        "403": {
          "description": "Secret does not match the lease"
        },
        "405": {
          "description": "Wrong method"
        },
        "429": {
          "description": "Rate limited"
        },
        "502": {
          "description": "Cloudflare API unavailable"
        },
        "503": {
          "description": "Worker unconfigured or relay storage unavailable"
        }
      }
    }
  },
  {
    "method": "POST",
    "path": "/api/relay/release",
    "summary": "Mark one relay lease released without removing its account resources",
    "doc": "标记租约已释放，保留账户内资源以便再次申领",
    "status": "200 / 400 / 403 / 405 / 503",
    "operation": {
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": [
                "id",
                "secret"
              ],
              "properties": {
                "id": {
                  "type": "string"
                },
                "secret": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Lease marked released"
        },
        "400": {
          "description": "Invalid JSON or parameters"
        },
        "403": {
          "description": "Secret does not match the lease"
        },
        "405": {
          "description": "Wrong method"
        },
        "503": {
          "description": "Relay storage unavailable"
        }
      }
    }
  },
  {
    "method": "POST",
    "path": "/api/relay/retire",
    "summary": "Remove one relay lease's DNS record, tunnel and row",
    "doc": "删除租约的 DNS 记录、隧道与数据行（唯一会移除中继来源的路径）",
    "status": "200 / 400 / 403 / 405 / 502 / 503",
    "operation": {
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": [
                "id",
                "secret"
              ],
              "properties": {
                "id": {
                  "type": "string"
                },
                "secret": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Lease removed"
        },
        "400": {
          "description": "Invalid JSON or parameters"
        },
        "403": {
          "description": "Secret does not match the lease"
        },
        "405": {
          "description": "Wrong method"
        },
        "502": {
          "description": "Cloudflare API unavailable"
        },
        "503": {
          "description": "Worker unconfigured or relay storage unavailable"
        }
      }
    }
  },
  {
    "method": "GET",
    "path": "/api/relay/bridge",
    "summary": "Open the bridge connector socket of one relay instance (WebSocket upgrade)",
    "doc": "打开实例的桥连接器 socket（WebSocket 升级，凭据为租约 id 与 secret）",
    "status": "101 / 403 / 426 / 429 / 503",
    "operation": {
      "responses": {
        "101": {
          "description": "Connector attached (the instance's object replaces any previous socket)"
        },
        "403": {
          "description": "Unknown id or wrong secret"
        },
        "426": {
          "description": "Upgrade required"
        },
        "429": {
          "description": "Rate limited"
        },
        "503": {
          "description": "Bridge not deployed or relay storage unavailable"
        }
      }
    }
  }
]
