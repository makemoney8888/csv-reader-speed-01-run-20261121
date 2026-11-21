// A fast drop-in for csv-reader 1.0.0.
//
// run(input) answers {columns, rows, errors} for {text, header} exactly as
// csv-reader 1.0.0 does, including its broken-row error reporting:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote, and each CRLF or lone CR inside it reads as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character, and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met: line the 1-based line
//     its record starts on, counting every LF, CRLF and lone CR inside quotes,
//     and row its record's index in rows, null for the header.
//
// Speed comes from never building a field one character at a time. A record
// with no quote and no stray CR in its line is split whole with String split.
// Every other field is scanned once with charCodeAt and cut out with slice;
// only a field that actually needs a change (a doubled quote, a line break
// inside quotes, a dropped CR) is assembled from segments. No regex, no
// per-character string concatenation anywhere on the hot path.

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Results of the field scanners below.
  let fValue = '';
  let fEnded = END;

  // Reads an unquoted field starting at pos. `seed` is null, or an array of
  // string segments that already belong to the field's value (the
  // unterminated-quote re-read seeds it with ['"']). Sets fValue / fEnded.
  function scanUnquoted(seed) {
    let parts = seed;
    let segStart = pos;
    let p = pos;
    let ended = END;
    let endPos = len;
    while (p < len) {
      const c = text.charCodeAt(p);
      if (c === 44) {
        ended = COMMA;
        endPos = p;
        pos = p + 1;
        break;
      }
      if (c === 10) {
        ended = BREAK;
        endPos = p;
        pos = p + 1;
        line += 1;
        break;
      }
      if (c === 13) {
        if (text.charCodeAt(p + 1) === 10) {
          ended = BREAK;
          endPos = p;
          pos = p + 2;
          line += 1;
          break;
        }
        // A CR not followed by LF is dropped, and the error is recorded.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        if (p > segStart) parts.push(text.slice(segStart, p));
        p += 1;
        segStart = p;
        continue;
      }
      p += 1;
    }
    if (ended === END) {
      endPos = len;
      pos = len;
    }
    fValue = parts === null ? text.slice(segStart, endPos) : parts.join('') + text.slice(segStart, endPos);
    fEnded = ended;
  }

  // Reads the junk that follows a closing quote, appending what it keeps to
  // `base`. A quote_junk error is recorded when anything was kept. Sets
  // fValue / fEnded.
  function scanJunk(base) {
    let parts = null;
    let segStart = pos;
    let p = pos;
    let added = 0;
    let ended = END;
    let endPos = len;
    while (p < len) {
      const c = text.charCodeAt(p);
      if (c === 44) {
        ended = COMMA;
        endPos = p;
        pos = p + 1;
        break;
      }
      if (c === 10) {
        ended = BREAK;
        endPos = p;
        pos = p + 1;
        line += 1;
        break;
      }
      if (c === 13) {
        if (text.charCodeAt(p + 1) === 10) {
          ended = BREAK;
          endPos = p;
          pos = p + 2;
          line += 1;
          break;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        if (p > segStart) {
          parts.push(text.slice(segStart, p));
          added += p - segStart;
        }
        p += 1;
        segStart = p;
        continue;
      }
      p += 1;
    }
    if (ended === END) {
      endPos = len;
      pos = len;
    }
    added += endPos - segStart;
    if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    fValue = parts === null ? base + text.slice(segStart, endPos) : base + parts.join('') + text.slice(segStart, endPos);
    fEnded = ended;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue / fEnded.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let p = pos + 1;
    let segStart = p;
    let parts = null;
    let closed = false;
    let closeAt = -1;
    while (p < len) {
      const c = text.charCodeAt(p);
      if (c === 34) {
        if (text.charCodeAt(p + 1) === 34) {
          // A doubled quote is one quote in the value.
          if (parts === null) parts = [];
          if (p > segStart) parts.push(text.slice(segStart, p));
          parts.push('"');
          p += 2;
          segStart = p;
          continue;
        }
        closed = true;
        closeAt = p;
        break;
      }
      if (c === 13 || c === 10) {
        // CRLF and a lone CR inside quotes are each one LF in the value.
        if (parts === null) parts = [];
        if (p > segStart) parts.push(text.slice(segStart, p));
        parts.push('\n');
        line += 1;
        p += c === 13 && text.charCodeAt(p + 1) === 10 ? 2 : 1;
        segStart = p;
        continue;
      }
      p += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      scanUnquoted(['"']);
      return;
    }
    const value = parts === null ? text.slice(segStart, closeAt) : parts.join('') + text.slice(segStart, closeAt);
    pos = closeAt + 1;
    if (pos >= len) {
      fValue = value;
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    scanJunk(value);
  }

  // Finishes a record: the header, or a row padded or cut to the first
  // record's width, with its short_row or long_row error when it ends.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record's first line holds no quote and no CR other
    // than its own CRLF ending, so the record is one plain line: split it
    // whole. A quoted field could only span lines if a quote opened before
    // this line's end, which the quote check rules out.
    const eol = text.indexOf('\n', pos);
    const end = eol === -1 ? len : eol;
    const q = text.indexOf('"', pos);
    if (q === -1 || q >= end) {
      const r = text.indexOf('\r', pos);
      if (r === -1 || r >= end || (r === end - 1 && eol !== -1)) {
        let contentEnd = end;
        if (r === end - 1 && eol !== -1) contentEnd = end - 1;
        const fields = text.slice(pos, contentEnd).split(',');
        pos = eol === -1 ? len : eol + 1;
        if (eol !== -1) line += 1;
        finishRecord(fields);
        continue;
      }
    }

    // Slow path: read the record field by field.
    const fields = [];
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        scanQuoted();
      } else {
        lastQuoted = false;
        scanUnquoted(null);
      }
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
