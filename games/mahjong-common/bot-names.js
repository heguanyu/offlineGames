// Bots are named by their SEAT (table position 东南西北 → seat index 0..3), so a bot in the 东 seat is
// 东方雨, 南 is 南宫云, 西 is 西门风, 北 is 北冥雪. The name is tied to the chair, not the rotating 座风,
// so it stays stable across hands. Shared by the offline game pages, the lobby, and the server (which
// imports it as ../games/mahjong-common/bot-names.js).
export const BOT_NAMES = ['东方雨', '南宫云', '西门风', '北冥雪'];
