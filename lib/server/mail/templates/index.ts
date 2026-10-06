// 메일 템플릿(디자인 EM-001~004·101·102). 각 함수는 { subject, text, html }을 돌려주고, 보내기는 mail/quota.ts의 sendMail이 한다.
// 어느 기능이 어느 템플릿을 쓰는지는 docs/ARCHITECTURE.md 「메일 템플릿」 표.
export { renderMail, type MailBody } from "./layout";
export { cancelledMail, deliveredMail, orderCompletedMail, shippedMail } from "./shopMails";
export type { CancelledInput, DeliveredInput, OrderBase, OrderCompletedInput, ShippedInput, ShopMailBrand } from "./shopMails";
export { partnerApprovedMail, partnerRejectedMail } from "./partnerMails";
export type { PartnerApprovedInput, PartnerRejectedInput, PlatformInfo } from "./partnerMails";
