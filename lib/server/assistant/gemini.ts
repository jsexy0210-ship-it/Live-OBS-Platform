// Gemini 호출(도우미). 키는 환경변수 GEMINI_API_KEY로만 읽고, 값은 코드·로그·오류 문구 어디에도 넣지 않는다.
// 모델 이름은 마스터 설정(AssistantSetting.model)이 정한다. 시험은 generate를 바꿔 끼운다.
export type GeminiRequest = { apiKey: string; model: string; system: string; question: string; maxOutputTokens: number };
export type GeminiResult = { text: string; inputTokens: number; outputTokens: number };
export type GeminiGenerate = (r: GeminiRequest) => Promise<GeminiResult>;

// refundable: Gemini가 처리하지 않았음이 확실한 실패(HTTP 4xx 응답)만 true. 시간 초과·네트워크 끊김·5xx·응답 해석 실패는
// 이미 과금됐을 수 있어 false(호출 쪽이 예상 비용을 돌려주지 않는다).
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly refundable: boolean,
  ) {
    super(message);
  }
}

export const GEMINI_TIMEOUT_MS = 20_000;
export const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export const assistantApiKey = () => (process.env.GEMINI_API_KEY ?? "").trim() || null;

export const geminiGenerate: GeminiGenerate = async ({ apiKey, model, system, question, maxOutputTokens }) => {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: question }] }],
      generationConfig: { maxOutputTokens, temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  // 오류 본문에 요청 내용이 섞일 수 있어 상태 코드만 남긴다
  if (!res.ok) throw new GeminiError(`gemini_http_${res.status}`, res.status >= 400 && res.status < 500);
  const j = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  const u = j.usageMetadata;
  if (!u || typeof u.promptTokenCount !== "number") throw new GeminiError("gemini_no_usage", false);
  // 생각 토큰도 출력 단가로 과금된다
  return { text, inputTokens: u.promptTokenCount, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
};
