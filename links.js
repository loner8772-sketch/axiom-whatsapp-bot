const TLDS = 'com|net|org|io|me|ly|co|xyz|ng|app|link|gl|tk|ml|ga|cf|gq|info|biz|site|online|store|shop|live|tv|cc|ws|vip|top|club|pro|dev|page|click|fun|icu|gg|bio|fm';
const LINK_RE = new RegExp(
  '(?:https?:\\/\\/|www\\.|chat\\.whatsapp\\.com\\/|wa\\.me\\/|t\\.me\\/)\\S+' +
  `|(?<![@\\w.-])[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?:\\/\\S*)?`,
  'i'
);

export const containsLink = (text) => LINK_RE.test(String(text || ''));
