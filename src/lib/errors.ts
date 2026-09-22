// 共享错误类型。
/** 服务端要求登录/会话失效（401），UI 据此弹出登录框。 */
export class AuthError extends Error {}
