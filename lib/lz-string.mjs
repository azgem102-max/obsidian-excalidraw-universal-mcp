/**
 * lz-string.mjs — ضغط وفك ضغط compressed-json الخاص بـObsidian Excalidraw
 *
 * نسخة مختصرة من LZ-String (compressToBase64 / decompressFromBase64 فقط)
 * مضمّنة داخل المستودع حتى تعمل أدوات الفحص والترميم **بلا أي اعتمادية npm**،
 * فتصلح للتشغيل في CI ومن أي وكيل بلا تنزيل.
 *
 * الأصل: LZ-String بواسطة pieroxy — رخصة MIT.
 */

const KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const REVERSE = (() => {
  const m = {};
  for (let i = 0; i < KEY.length; i += 1) m[KEY.charAt(i)] = i;
  return m;
})();

export function compressToBase64(input) {
  if (input == null) return "";
  const res = _compress(input, 6, (a) => KEY.charAt(a));
  switch (res.length % 4) {
    case 0: return res;
    case 1: return `${res}===`;
    case 2: return `${res}==`;
    default: return `${res}=`;
  }
}

export function decompressFromBase64(input) {
  if (input == null || input === "") return null;
  return _decompress(input.length, 32, (index) => REVERSE[input.charAt(index)]);
}

function _compress(uncompressed, bitsPerChar, getCharFromInt) {
  if (uncompressed == null) return "";
  const dictionary = {};
  const dictionaryToCreate = {};
  const data = [];
  let c = "", wc = "", w = "";
  let enlargeIn = 2, dictSize = 3, numBits = 2;
  let dataVal = 0, dataPosition = 0;

  const writeBits = (value, bits) => {
    for (let i = 0; i < bits; i += 1) {
      dataVal = (dataVal << 1) | (value & 1);
      if (dataPosition === bitsPerChar - 1) {
        dataPosition = 0;
        data.push(getCharFromInt(dataVal));
        dataVal = 0;
      } else dataPosition += 1;
      value >>= 1;
    }
  };

  const flushNew = (token) => {
    if (Object.prototype.hasOwnProperty.call(dictionaryToCreate, token)) {
      if (token.charCodeAt(0) < 256) {
        writeBits(0, numBits);
        writeBits(token.charCodeAt(0), 8);
      } else {
        writeBits(1, numBits);
        writeBits(token.charCodeAt(0), 16);
      }
      enlargeIn -= 1;
      if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits += 1; }
      delete dictionaryToCreate[token];
    } else {
      writeBits(dictionary[token], numBits);
    }
  };

  for (let ii = 0; ii < uncompressed.length; ii += 1) {
    c = uncompressed.charAt(ii);
    if (!Object.prototype.hasOwnProperty.call(dictionary, c)) {
      dictionary[c] = dictSize++;
      dictionaryToCreate[c] = true;
    }
    wc = w + c;
    if (Object.prototype.hasOwnProperty.call(dictionary, wc)) {
      w = wc;
    } else {
      flushNew(w);
      enlargeIn -= 1;
      if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits += 1; }
      dictionary[wc] = dictSize++;
      w = String(c);
    }
  }

  if (w !== "") {
    flushNew(w);
    enlargeIn -= 1;
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits += 1; }
  }

  writeBits(2, numBits);

  for (;;) {
    dataVal <<= 1;
    if (dataPosition === bitsPerChar - 1) { data.push(getCharFromInt(dataVal)); break; }
    dataPosition += 1;
  }
  return data.join("");
}

function _decompress(length, resetValue, getNextValue) {
  const dictionary = [];
  let enlargeIn = 4, dictSize = 4, numBits = 3, entry = "", w, c;
  const result = [];
  const data = { val: getNextValue(0), position: resetValue, index: 1 };

  for (let i = 0; i < 3; i += 1) dictionary[i] = i;

  const readBits = (max) => {
    let bits = 0, power = 1;
    while (power !== max) {
      const resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) { data.position = resetValue; data.val = getNextValue(data.index++); }
      bits |= (resb > 0 ? 1 : 0) * power;
      power <<= 1;
    }
    return bits;
  };

  switch (readBits(4)) {
    case 0: c = String.fromCharCode(readBits(256)); break;
    case 1: c = String.fromCharCode(readBits(65536)); break;
    default: return "";
  }
  dictionary[3] = c;
  w = c;
  result.push(c);

  for (;;) {
    if (data.index > length) return "";
    let cc = readBits(2 ** numBits);
    switch (cc) {
      case 0:
        dictionary[dictSize++] = String.fromCharCode(readBits(256));
        cc = dictSize - 1;
        enlargeIn -= 1;
        break;
      case 1:
        dictionary[dictSize++] = String.fromCharCode(readBits(65536));
        cc = dictSize - 1;
        enlargeIn -= 1;
        break;
      case 2:
        return result.join("");
    }

    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits += 1; }

    if (dictionary[cc] !== undefined) entry = dictionary[cc];
    else if (cc === dictSize) entry = w + w.charAt(0);
    else return null;

    result.push(entry);
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn -= 1;
    w = entry;

    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits += 1; }
  }
}

/** يقرأ مشهد Excalidraw من نص ملف .excalidraw.md مهما كانت كتلته مضغوطة أو خامًا. */
export function parseSceneFromMarkdown(md) {
  const compressed = md.match(/```compressed-json\r?\n([\s\S]*?)\r?\n```/);
  if (compressed) {
    const json = decompressFromBase64(compressed[1].replace(/\s+/g, ""));
    if (!json) throw new Error("تعذر فك ضغط compressed-json");
    return { scene: JSON.parse(json), compressed: true, raw: compressed[0] };
  }
  const plain = md.match(/```json\r?\n([\s\S]*?)\r?\n```/);
  if (plain) return { scene: JSON.parse(plain[1]), compressed: false, raw: plain[0] };
  throw new Error("لا توجد كتلة رسم في الملف");
}

/** يعيد كتابة نص الملف بمشهد جديد، محافظًا على نوع الكتلة وسطر العرض 100. */
export function replaceSceneInMarkdown(md, scene) {
  const { compressed, raw } = parseSceneFromMarkdown(md);
  const body = compressed
    ? `\`\`\`compressed-json\n${compressToBase64(JSON.stringify(scene)).replace(/(.{100})/g, "$1\n")}\n\`\`\``
    : `\`\`\`json\n${JSON.stringify(scene, null, 2)}\n\`\`\``;
  return md.replace(raw, body);
}
