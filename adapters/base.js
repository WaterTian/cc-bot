// IM Adapter 基类 — 所有 IM 实现（lark / wecom / slack / ...）必须符合本接口。
//
// 设计原则：
//   1. 所有方法返回 Promise；失败抛 Error（不返 null / false）
//   2. listRecentMessages 返回标准化的 Message[]，adapter 负责把各 IM 的原始结构归一
//   3. adapter 不做业务逻辑（去重 / 限流 / state 推进），那些归 poll.js / skill
//   4. adapter 不碰文件系统，除了 downloadResource 的 output 路径

/**
 * @typedef {Object} Message
 * @property {string} id              平台消息 ID（飞书 om_xxx）
 * @property {string} senderId        发送者 ID（飞书 open_id 或 app_id）
 * @property {'bot'|'user'} senderType 发送者类型（用于过滤 bot 自己发的）
 * @property {'text'|'post'|'file'|'image'} type 标准化的消息类型
 * @property {string} content         文本内容（post 已渲染为"文字 + [Image: xxx]"形式）
 * @property {number} createTimeMs    Unix ms 时间戳
 * @property {object} [raw]           原始数据，供 adapter 专属逻辑访问
 */

/**
 * @typedef {Object} User
 * @property {string} id
 * @property {string} name
 */

/**
 * IM Adapter 抽象接口。
 * 子类必须实现所有抽象方法，以及 botIdentity getter。
 */
class IMAdapter {
  /**
   * 当前 bot 的身份标识，用于在 listRecentMessages 结果里过滤 bot 自发的消息。
   * @returns {{id: string, name?: string}}
   */
  get botIdentity() {
    throw new Error('Not implemented: botIdentity')
  }

  /**
   * 拉取最近消息（降序，最新在前）。
   * @param {{chatId: string, pageSize?: number}} opts
   * @returns {Promise<Message[]>}
   */
  async listRecentMessages(opts) {
    throw new Error('Not implemented: listRecentMessages')
  }

  /**
   * 发送纯文本。
   * @param {{chatId: string, text: string, replyTo?: string}} opts
   *   replyTo: 存在则以回复形式发送（飞书 messages-reply），否则新起一条
   * @returns {Promise<{id: string}>}
   */
  async sendText(opts) {
    throw new Error('Not implemented: sendText')
  }

  /**
   * 发送图片。
   * @param {{chatId: string, imagePath: string, replyTo?: string}} opts
   *   imagePath: 平台要求的路径（lark-cli 要求相对当前 cwd 的路径）
   * @returns {Promise<{id: string}>}
   */
  async sendImage(opts) {
    throw new Error('Not implemented: sendImage')
  }

  /**
   * 下载消息里的资源（图片 / 文件）到本地。
   * @param {{messageId: string, fileKey: string, type: 'image'|'file', output: string}} opts
   * @returns {Promise<{path: string}>} path = output 的绝对路径
   */
  async downloadResource(opts) {
    throw new Error('Not implemented: downloadResource')
  }

  /**
   * 查询用户信息（通讯录）。
   * @param {{userId: string}} opts
   * @returns {Promise<User>}
   */
  async getUser(opts) {
    throw new Error('Not implemented: getUser')
  }
}

module.exports = { IMAdapter }
