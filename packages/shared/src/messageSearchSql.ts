import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./composerContextReferences.ts";

// SQLite's ltrim needs the characters matched by isAttachmentOnlyBootstrapPrompt's \s explicitly.
const BOOTSTRAP_PREFIX_WHITESPACE =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export const nonPlaceholderMessageConditionSql = (row = "messages") =>
  `
  CASE
    WHEN substr(json_extract(${row}.payload_json, '$.text'), 1, 11) = 'Ultrathink:' COLLATE NOCASE
      THEN ltrim(substr(json_extract(${row}.payload_json, '$.text'), 12), '${BOOTSTRAP_PREFIX_WHITESPACE}')
    ELSE json_extract(${row}.payload_json, '$.text')
  END COLLATE BINARY <> '${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT.replaceAll("'", "''")}'
`;

export const indexedMessageConditionSql = (row = "messages") =>
  `
  ${row}.streaming = 0
  AND (
    ${row}.role = 'assistant'
    OR (
      ${row}.role = 'user'
      AND COALESCE(json_extract(${row}.payload_json, '$.createdBy'), 'user') = 'user'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_threads AS subagent_threads
    WHERE subagent_threads.thread_id = ${row}.thread_id
      AND json_extract(subagent_threads.payload_json, '$.lineage.relationshipToParent') = 'subagent'
  )
  AND ${nonPlaceholderMessageConditionSql(row)}
`;

export const indexedMessageTextSql = (payload: string) =>
  `replace(replace(json_extract(${payload}, '$.text'), '’', ''''), '‘', '''')`;
