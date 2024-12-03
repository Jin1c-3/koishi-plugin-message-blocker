import { Context, Schema, h, $, difference } from "koishi";
import {} from "@koishijs/cache";
import fs from "fs";
import path from "path";
import imghash from "imghash";
import { distance } from "fastest-levenshtein";
import { pinyin, match as pinyinnmatch } from "pinyin-pro";
import sharp from "sharp";

export const reusable = true;

export const inject = {
  required: ["database"],
  optional: ["cache"],
};

export const name = "message-blocker";

export interface Config {
  text_exact?: boolean;
  text_lowercase?: boolean;
  regex_exact?: boolean;
  pinyin_exact?: boolean;
  image_similarity?: number;
  page_size?: number;
  mute_flag?: boolean;
  mute_duration?: number;
  delete_flag?: boolean;
  alert_flag?: boolean;
  bubble?: boolean;
  self_delete?: boolean;
  self_delete_duration?: number;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    text_exact: Schema.boolean().default(false),
    text_lowercase: Schema.boolean().default(true),
    regex_exact: Schema.boolean().default(false).disabled(),
    pinyin_exact: Schema.boolean().default(true).disabled(),
    image_similarity: Schema.number()
      .role("slider")
      .min(0)
      .max(1)
      .step(0.01)
      .default(0.3),
  }),
  Schema.object({ page_size: Schema.natural().max(50).default(5) }),
  Schema.intersect([
    Schema.intersect([
      Schema.object({ mute_flag: Schema.boolean().default(false) }),
      Schema.union([
        Schema.object({
          mute_flag: Schema.const(true).required(),
          mute_duration: Schema.number()
            .min(1)
            .max(60 * 24 * 30)
            .default(30),
        }),
        Schema.object({}),
      ]),
    ]),

    Schema.object({
      delete_flag: Schema.boolean().default(true),
    }),
    Schema.object({
      bubble: Schema.boolean().default(true),
    }),
    Schema.intersect([
      Schema.object({
        alert_flag: Schema.boolean().default(false),
      }),
      Schema.union([
        Schema.intersect([
          Schema.object({
            alert_flag: Schema.const(true).required(),
            self_delete: Schema.boolean().default(false),
          }),
          Schema.union([
            Schema.object({
              self_delete: Schema.const(true).required(),
              self_delete_duration: Schema.number()
                .role("slider")
                .step(1)
                .min(5)
                .max(5 * 60)
                .default(100),
            }),
            Schema.object({}),
          ]),
        ]),
      ]),
    ]),
  ]),
]).i18n({ "zh-CN": require("./locales/zh_CN")._config });

// 规则支持的类型
enum RuleType {
  TEXT = 1,
  REGEX = 2,
  PINYIN = 3,
  IMAGE = 4,
}

interface messageBlockerRule {
  id: number;
  type: number; // 对应规则类型
  origin: string; // 原始消息文字、图片名
  actual: string; // 文字、正则或者图片哈希
}

// 多对多关系
interface messageBlockerGuild {
  guild: string;
  ruleId: number; // 外键
}

declare module "koishi" {
  interface Tables {
    messageBlockerRule: messageBlockerRule;
    messageBlockerGuild: messageBlockerGuild;
  }
}

declare module "@koishijs/cache" {
  interface Tables {
    "image-hash": string;
  }
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger("message-blocker");
  const storage_root = path.join(ctx.baseDir, "data", name);
  ctx.i18n.define("zh-CN", require("./locales/zh_CN"));
  ctx.model.extend(
    "messageBlockerRule",
    {
      id: "unsigned",
      type: "unsigned",
      origin: "string",
      actual: "string",
    },
    { primary: "id", autoInc: true }
  );
  ctx.model.extend(
    "messageBlockerGuild",
    {
      guild: "string",
      ruleId: "unsigned",
    },
    {
      primary: ["guild", "ruleId"],
      foreign: {
        // messageBlockerGuild.ruleId 必须是某一个 messageBlockerRule.id
        ruleId: ["messageBlockerRule", "id"],
      },
    }
  );

  async function transferImage(image: Buffer) {
    return await sharp(image)
      .resize(256, 256, { fit: "inside" }) // Resize to a standard size
      .grayscale() // Convert to grayscale
      .normalize() // Normalize the image
      .toBuffer();
  }

  function stringToRegex(str: string): RegExp | null {
    const match = str.match(/^\/(.+)\/([gimsuy]*)$/);
    if (match) {
      try {
        return new RegExp(match[1], match[2]);
      } catch (e) {
        logger.error("Invalid regular expression:", e);
        return null;
      }
    }
    return new RegExp(str);
  }

  // 返回值表示是否next()
  async function handleMatchedMessage(session) {
    if (config.delete_flag) {
      await session.bot.deleteMessage(session.guildId, session.messageId);
    }
    if (config.mute_flag) {
      await session.bot.muteGuildMember(
        session.guildId,
        session.userId,
        config.mute_duration * 60000
      );
    }
    if (config.alert_flag) {
      const res = await session.send(
        session.text("commands.message-blocker.messages.alert")
      );
      if (config.self_delete) {
        ctx.setTimeout(() => {
          session.bot.deleteMessage(session.guildId, res);
        }, config.self_delete_duration * 1000);
      }
    }
    if (config.bubble) {
      return false;
    }
    return true;
  }

  // 公共函数：验证群组
  async function validateGroups(
    session,
    inputGroups: string[] = []
  ): Promise<string[]> {
    if (!inputGroups.length && !session.guildId) {
      throw new Error(
        session.text("commands.message-blocker.messages.no_group")
      );
    }

    let groups = inputGroups.length ? inputGroups : [session.guildId];
    const bot_groups = (await session.bot.getGuildList()).data.map(
      (guild) => guild.id
    );

    if (groups.some((g) => !bot_groups.includes(g))) {
      throw new Error(
        session.text("commands.message-blocker.messages.invalid_group")
      );
    }

    return groups;
  }

  // 公共函数：显示规则详情
  function displayRule(rule) {
    const inner_msg = h("message", {}, []);
    inner_msg.children.push(h("p", `id: ${rule.messageBlockerRule.id}`));
    inner_msg.children.push(h("p", `群组: ${rule.messageBlockerGuild.guild}`));
    inner_msg.children.push(
      h(
        "p",
        `类型: ${Object.keys(RuleType).find(
          (key) => RuleType[key] === rule.messageBlockerRule.type
        )}`
      )
    );
    inner_msg.children.push(
      h("p", `原始规则: ${rule.messageBlockerRule.origin}`)
    );
    inner_msg.children.push(
      h("p", `实际规则: ${rule.messageBlockerRule.actual}`)
    );

    if (rule.messageBlockerRule.type === RuleType.IMAGE) {
      const img_path = path.join(storage_root, rule.messageBlockerRule.origin);
      inner_msg.children.push(h.image(img_path));
    }

    return inner_msg;
  }

  ctx
    .command("message-blocker.add <type:natural> [...groups:string]", "", {
      authority: 3,
    })
    .action(async ({ session }, type, ...groups) => {
      if (type === undefined) {
        type = 1;
      }
      if (!Object.values(RuleType).includes(type)) {
        return session.text(".invalid_type");
      }
      try {
        groups = await validateGroups(session, groups);
      } catch (e) {
        return e.message;
      }

      // 获取用户输入，有机会取消操作
      await session.send(session.text(".what"));
      const input = await session.prompt();
      if (!input) {
        return session.text(".timeout");
      }
      if (/^.{0,1}取消$/.test(input.trim())) {
        return session.text("commands.message-blocker.messages.cancel");
      }
      let h_input: h[];
      if (type === RuleType.IMAGE) {
        if (!fs.existsSync(storage_root)) {
          fs.mkdirSync(storage_root, { recursive: true });
        }
        h_input = [...h.select(input, "img"), ...h.select(input, "image")];
        let images_to_save = h_input
          .filter(
            (value, index, self) =>
              index ===
              self.findIndex((i) => i.attrs.filename === value.attrs.filename)
          )
          .map((i) => i.attrs);
        // 让用户确认
        await session.send(session.text(".confirm", [images_to_save.length]));
        const confirm = h.select(await session.prompt(), "text")[0].attrs
          .content;
        if (!/^Y$/.test(confirm)) {
          return session.text("commands.message-blocker.messages.cancel");
        }
        // 存储数据
        await Promise.all(
          images_to_save.map(async (i) => {
            // 获取图片数据
            const buffer = await transferImage(
              Buffer.from(
                await ctx.http.get(i.src, {
                  responseType: "arraybuffer",
                })
              )
            );
            // 转存图片
            const img_path = path.join(storage_root, i.filename);
            fs.writeFileSync(img_path, buffer);
            // 获取图片hash
            const hash = await imghash.hash(img_path);
            // 检查规则是否已存在
            const existingRules = await ctx.database.get("messageBlockerRule", {
              actual: hash,
            });
            let ruleId: number;
            if (existingRules.length) {
              ruleId = existingRules[0].id;
            } else {
              // 添加到数据库
              const res = await ctx.database.create("messageBlockerRule", {
                type: RuleType.IMAGE,
                origin: i.filename,
                actual: hash,
              });
              ruleId = res.id;
            }
            // 关联规则与群组
            const batch = groups.map((group) => ({
              guild: group,
              ruleId: ruleId,
            }));
            await ctx.database.upsert("messageBlockerGuild", batch);
          })
        );
      } else {
        h_input = h.select(input, "text");
        const origin_rules = h_input
          .map((i) => i.attrs.content)
          .join("\n")
          .split("\n")
          .map((r) => r.trim())
          .filter((r) => r.length)
          .filter((value, index, self) => self.indexOf(value) === index);
        let actual_rules: string[] | RegExp[] = origin_rules;
        if (type === RuleType.REGEX) {
          try {
            actual_rules = origin_rules.map((r) => stringToRegex(r));
          } catch (e) {
            return session.text(".invalid_regex");
          }
        }
        // 让用户确认一下
        await session.send(session.text(".confirm", [origin_rules.length]));
        const confirm = h.select(await session.prompt(), "text")[0].attrs
          .content;
        if (!/^Y$/.test(confirm)) {
          return session.text("commands.message-blocker.messages.cancel");
        }
        // 存储数据，分类型操作
        await Promise.all(
          origin_rules.map(async (origin_rule, index) => {
            // 检查规则是否已存在
            const existingRules = await ctx.database.get("messageBlockerRule", {
              actual: actual_rules[index].toString(),
            });
            let ruleId: number;
            if (existingRules.length) {
              ruleId = existingRules[0].id;
            } else {
              // 添加到数据库
              const res = await ctx.database.create("messageBlockerRule", {
                type: type,
                origin: origin_rule,
                actual: actual_rules[index].toString(),
              });
              ruleId = res.id;
            }
            // 关联规则与群组
            const batch = groups.map((group) => ({
              guild: group,
              ruleId: ruleId,
            }));
            await ctx.database.upsert("messageBlockerGuild", batch);
          })
        );
      }
      return session.text(".success");
    });

  ctx
    .command("message-blocker.list [group:string]", "", { authority: 3 })
    .option("page", "-p <page:natural>", { fallback: 1 })
    .action(async ({ session, options }, group) => {
      try {
        [group] = await validateGroups(session, group ? [group] : []);
      } catch (e) {
        return e.message;
      }

      const rules = await ctx.database
        .join(["messageBlockerGuild", "messageBlockerRule"], (G, R) =>
          $.eq(G.ruleId, R.id)
        )
        .orderBy("messageBlockerRule.id")
        .limit(config.page_size)
        .offset((options.page - 1) * config.page_size)
        .execute();

      if (!rules.length) return session.text(".nothing");

      const result = h(
        "message",
        { forward: true },
        rules.map((rule) => displayRule(rule))
      );

      return result;
    });

  ctx
    .command("message-blocker.del <ids:string> [...groups:string]", "", {
      authority: 3,
    })
    .action(async ({ session }, ids, ...groups) => {
      const ids_to_remove = ids.split(",").map((i) => {
        if (i.length) return parseInt(i.trim());
      });
      if (!ids_to_remove.length) {
        return session.text(".invalid_id");
      }
      try {
        groups = await validateGroups(session, groups);
      } catch (e) {
        return e.message;
      }
      // 查询规则是否存在
      const rules = await ctx.database
        .join(["messageBlockerGuild", "messageBlockerRule"], (G, R) =>
          $.eq(G.ruleId, R.id)
        )
        .where((row) =>
          $.and(
            $.in(row.messageBlockerRule.id, ids_to_remove),
            $.in(row.messageBlockerGuild.guild, groups)
          )
        )
        .orderBy("messageBlockerRule.id")
        .execute();
      await session.send(session.text(".confirm", [rules.length]));

      const result = h(
        "message",
        { forward: true },
        rules.map((rule) => displayRule(rule))
      );

      await session.send(result);
      // 让用户确认
      const confirm = h.select(await session.prompt(), "text")[0].attrs.content;
      if (!/^Y$/.test(confirm)) {
        return session.text("commands.message-blocker.messages.cancel");
      }
      const res = await ctx.database.remove("messageBlockerGuild", (row) =>
        $.and($.in(row.ruleId, ids_to_remove), $.in(row.guild, groups))
      );
      if (res.matched === res.removed) {
        // 删除规则表中没有群组与之关联的行
        const diff = difference(
          ids_to_remove,
          (
            await ctx.database
              .select("messageBlockerGuild")
              .where((row) => $.in(row.ruleId, ids_to_remove))
              .execute()
          ).map((r) => r.ruleId)
        );
        const image_rules_to_remove = await ctx.database.get(
          "messageBlockerRule",
          (row) => $.and($.in(row.id, diff), $.eq(row.type, RuleType.IMAGE))
        );
        await Promise.all(
          image_rules_to_remove.map(async (r) => {
            const img_path = path.join(storage_root, r.origin);
            if (fs.existsSync(img_path)) {
              fs.unlinkSync(img_path);
            }
          })
        );
        await ctx.database.remove("messageBlockerRule", (row) =>
          $.in(row.id, diff)
        );
        return session.text(".success");
      } else {
        return session.text(".failed", [res.matched, res.removed]);
      }
    });

  // 缓存编译后的正则表达式
  const regexCache = new Map<string, RegExp>();

  // 检查文本是否匹配规则
  async function checkTextRules(texts_to_check: string, rules: any) {
    // 检查文本规则
    for (let rule of rules.text) {
      if (config.text_exact) {
        if (texts_to_check === rule) return true;
      } else {
        if (texts_to_check.includes(rule)) return true;
      }
    }

    // 检查正则规则
    for (let ruleStr of rules.regex) {
      let regex = regexCache.get(ruleStr);
      if (!regex) {
        regex = stringToRegex(ruleStr);
        if (regex) regexCache.set(ruleStr, regex);
      }
      if (regex?.test(texts_to_check)) return true;
    }

    return false;
  }

  // 检查图片是否匹配规则
  async function checkImageRules(images: any[], rules: string[]) {
    if (images.length === 0 || rules.length === 0) return false;

    const hashes = await Promise.all(
      images.map(async (img) => {
        try {
          // 优先使用缓存
          if (ctx.cache) {
            const hash = await ctx.cache.get("image-hash", img.filename);
            if (hash) return hash;
          }

          // 处理图片并获取hash
          const buffer = await transferImage(
            Buffer.from(
              await ctx.http.get(img.src, { responseType: "arraybuffer" })
            )
          );

          // 使用内存中的buffer直接计算hash
          const hash = await imghash.hash(buffer);

          // 异步保存缓存
          if (ctx.cache) {
            ctx.cache
              .set("image-hash", img.filename, hash, 60 * 60 * 1000 * 24)
              .catch((err) => {
                logger.error("Cache set error:", err);
              });
          }

          return hash;
        } catch (error) {
          logger.error("Error processing image:", error);
          return null;
        }
      })
    );

    // 过滤无效的hash并检查相似度
    const validHashes = hashes.filter(Boolean);
    for (const rule of rules) {
      for (const hash of validHashes) {
        const dist = distance(hash, rule);
        if (
          dist / Math.min(rule.length, hash.length) <=
          config.image_similarity
        ) {
          logger.info("found similar image, distance:", dist);
          return true;
        }
      }
    }

    return false;
  }

  ctx.middleware(async (session, next) => {
    // 快速检查：非群聊或非普通成员直接放行
    if (!session.guildId) return next();

    const member = await session.bot.getGuildMember(
      session.guildId,
      session.userId
    );
    if (!member.roles.includes("member")) return next();

    // 获取群组规则
    const origin_rules = await ctx.database
      .join(["messageBlockerGuild", "messageBlockerRule"], (G, R) =>
        $.eq(G.ruleId, R.id)
      )
      .where((row) => $.eq(row.messageBlockerGuild.guild, session.guildId))
      .execute();

    if (!origin_rules.length) return next();

    // 提取和预处理规则
    const rules = {
      text: config.text_lowercase
        ? origin_rules
            .filter((r) => r.messageBlockerRule.type === RuleType.TEXT)
            .map((r) => r.messageBlockerRule.actual.toLowerCase())
        : origin_rules
            .filter((r) => r.messageBlockerRule.type === RuleType.TEXT)
            .map((r) => r.messageBlockerRule.actual),
      regex: origin_rules
        .filter((r) => r.messageBlockerRule.type === RuleType.REGEX)
        .map((r) => r.messageBlockerRule.actual),
      image: origin_rules
        .filter((r) => r.messageBlockerRule.type === RuleType.IMAGE)
        .map((r) => r.messageBlockerRule.actual),
    };

    // 提取消息内容
    const text_elements = h.select(session.content, "text");
    const image_elements = [
      ...h.select(session.content, "image"),
      ...h.select(session.content, "img"),
    ];

    // 文本检查
    if (text_elements.length) {
      const texts_to_check = config.text_lowercase
        ? text_elements
            .map((e) => e.attrs.content)
            .join("")
            .toLowerCase()
        : text_elements.map((e) => e.attrs.content).join("");

      if (await checkTextRules(texts_to_check, rules)) {
        return handleMatchedMessage(session) ? next() : undefined;
      }
    }

    // 图片检查
    if (image_elements.length) {
      if (
        await checkImageRules(
          image_elements.map((e) => e.attrs),
          rules.image
        )
      ) {
        return handleMatchedMessage(session) ? next() : undefined;
      }
    }

    return next();
  }, true);
}
