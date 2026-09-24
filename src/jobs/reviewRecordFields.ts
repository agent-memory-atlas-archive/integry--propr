/**
 * Record field grammar shared by the private reviewer contract, the public
 * comment contract, and every serializer that feeds `/fix`.
 *
 * A field starts on an unindented `- **name:** value` (or `- name: value`)
 * line. It continues on the lines that follow until the next unindented field
 * line, a thematic break (`---`), or the end of the record:
 *   - blank lines separate paragraphs and list blocks inside the field;
 *   - indented lines (space or tab) hold paragraphs, numbered or bulleted
 *     lists, nested label-like text, and fenced code; and
 *   - unindented paragraph text directly after a non-blank field line is a
 *     Markdown lazy continuation of that paragraph, unless it starts a block.
 *
 * Only unindented field lines and the `### F#`/`### S#` and `## ` headings
 * that delimit records and sections are structural, so indented text that
 * looks like a label, list item, or heading always stays inside its field.
 * Any other unindented content — text before the first field, a top-level
 * list item, heading, or table, content after a thematic break, or text that
 * escapes an open code fence — is unsupported. It rejects the record instead
 * of being silently dropped from otherwise complete-looking evidence.
 *
 * Values keep the first line as written and dedent continuation lines by
 * their common indentation, so renderers can indent them beneath any
 * `- **label:**` bullet without changing their Markdown structure.
 */

const FIELD_BOLD_RE = /^[-*][ \t]+\*\*([^*]+)\*\*[ \t]*(.*)$/;
const FIELD_PLAIN_RE = /^[-*][ \t]+([A-Za-z][A-Za-z0-9 -]*):[ \t]*(.*)$/;
const THEMATIC_BREAK_RE = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** Unindented text that would open a new Markdown block rather than continue a paragraph. */
const BLOCK_START_RE = /^(?:[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|#{1,6}(?:[ \t]|$)|>|`{3,}|~{3,}|\||<)/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const HEADING_RE = /^#{1,6}(?:[ \t]|$)/;

interface FieldHeader {
    key: string;
    value: string;
}

function matchFieldHeader(line: string): FieldHeader | null {
    const match = FIELD_BOLD_RE.exec(line) ?? FIELD_PLAIN_RE.exec(line);
    if (!match) return null;
    return {
        key: match[1].replace(/:$/, '').replace(/[\s-]/g, '').toLowerCase(),
        value: match[2].replace(/^:\s*/, '').trim(),
    };
}

/** Whether any line of a record body is shaped like a top-level field line. */
export function hasRecordFieldHeader(block: string): boolean {
    return block.split(/\r?\n/).some(line => matchFieldHeader(line) !== null);
}

interface ContinuationLine {
    text: string;
    lazy: boolean;
}

interface OpenField {
    key: string;
    first: string;
    continuation: ContinuationLine[];
}

function buildFieldValue(field: OpenField): string {
    const indents = field.continuation
        .filter(line => !line.lazy && line.text !== '')
        .map(line => line.text.length - line.text.trimStart().length);
    const dedent = indents.length > 0 ? Math.min(...indents) : 0;
    const lines = [
        field.first,
        ...field.continuation.map(line => (line.lazy ? line.text : line.text.slice(dedent))),
    ];
    while (lines.length > 0 && lines[0] === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
}

/** Line-by-line reader for the field grammar documented above. */
class RecordFieldReader {
    private readonly fields = new Map<string, string>();
    private current: OpenField | null = null;
    private openFence: { char: string; length: number } | null = null;

    constructor(private readonly allowedKeys?: ReadonlySet<string>) {}

    /** Consume one line; false means the record uses unsupported formatting. */
    read(rawLine: string): boolean {
        const line = rawLine
            .replace(/^[ \t]+/, whitespace => whitespace.replace(/\t/g, '    '))
            .trimEnd();
        if (line === '') {
            this.current?.continuation.push({ text: '', lazy: false });
            return true;
        }
        if (/^ /.test(line)) return this.readIndented(line);
        // Unindented text inside an indented fence would end the enclosing
        // list item in Markdown, so it can never belong to the field.
        if (this.openFence) return false;

        const header = matchFieldHeader(line);
        if (header) {
            if (!this.finishField()) return false;
            this.current = { key: header.key, first: header.value, continuation: [] };
            return true;
        }
        if (THEMATIC_BREAK_RE.test(line)) return this.finishField();
        return this.readLazyContinuation(line);
    }

    /** Close the record, returning its fields or null when it is unsupported. */
    finish(): Map<string, string> | null {
        return !this.openFence && this.finishField() ? this.fields : null;
    }

    private readIndented(line: string): boolean {
        if (!this.current) return false;
        const trimmed = line.trimStart();
        if (this.openFence) {
            const { char, length } = this.openFence;
            if (new RegExp(`^${char}{${length},}$`).test(trimmed)) this.openFence = null;
        } else {
            const fence = FENCE_RE.exec(trimmed);
            if (fence) this.openFence = { char: fence[1][0], length: fence[1].length };
        }
        this.current.continuation.push({ text: line, lazy: false });
        return true;
    }

    private readLazyContinuation(line: string): boolean {
        if (!this.current || BLOCK_START_RE.test(line)) return false;
        const { continuation } = this.current;
        // With no continuation yet, the previous line is the field line itself.
        if (continuation.length > 0) {
            const previous = continuation[continuation.length - 1].text.trim();
            if (previous === '' || HEADING_RE.test(previous)) return false;
        }
        continuation.push({ text: line, lazy: true });
        return true;
    }

    private finishField(): boolean {
        const field = this.current;
        if (!field) return true;
        if (this.fields.has(field.key) || (this.allowedKeys && !this.allowedKeys.has(field.key))) return false;
        this.fields.set(field.key, buildFieldValue(field));
        this.current = null;
        return true;
    }
}

/**
 * Parse a record body into normalized field values, or null when it contains
 * content the field grammar above does not support. Duplicate fields are
 * rejected, as are fields outside `allowedKeys` when that set is supplied.
 */
export function extractRecordFields(block: string, allowedKeys?: ReadonlySet<string>): Map<string, string> | null {
    const reader = new RecordFieldReader(allowedKeys);
    for (const line of block.replace(/\r\n?/g, '\n').split('\n')) {
        if (!reader.read(line)) return null;
    }
    return reader.finish();
}

/**
 * Render one record field as a Markdown bullet. Continuation lines are
 * indented beneath the bullet, which keeps lists and paragraphs inside the
 * field when GitHub renders the comment and when the parser reads it back.
 * Multiline values that open with a block such as a numbered list start on
 * their own line so Markdown does not fold that block into the label.
 */
export function formatRecordField(label: string, value: string): string {
    const lines = value.split('\n');
    const leadsWithBlock = lines.length > 1 && BLOCK_START_RE.test(lines[0]);
    const header = leadsWithBlock ? `- **${label}:**` : `- **${label}:** ${lines.shift() ?? ''}`.trimEnd();
    const body = leadsWithBlock ? ['', ...lines] : lines;
    return [header, ...body.map(line => (line === '' ? '' : `  ${line}`))].join('\n');
}

/**
 * Render a record's fields. Single-line records stay compact; a record with
 * any multiline value separates its fields with blank lines for readability.
 */
export function formatRecordFields(fields: ReadonlyArray<readonly [label: string, value: string]>): string {
    const multiline = fields.some(([, value]) => value.includes('\n'));
    return fields.map(([label, value]) => formatRecordField(label, value)).join(multiline ? '\n\n' : '\n');
}
