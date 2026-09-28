using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
namespace EduMaster.Core;

public sealed class GeminiGenerator(HttpClient client)
{
    public const string DefaultModel = "gemini-3.8-flash";
    public const string PromptVersion = "file-variant-v1";
    public async Task<SampleResult> GenerateAsync(ProblemDraft draft, string directory, string apiKey, string model,
        IProgress<string>? progress = null, CancellationToken token = default)
    {
        draft.Validate();
        if (string.IsNullOrWhiteSpace(apiKey)) throw new ArgumentException("AI 설정에서 Gemini API 키를 입력해 주세요.");
        apiKey = apiKey.Trim();
        if (apiKey.Length > 512 || apiKey.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-' && c != '_'))
            throw new ArgumentException("Gemini API 키 형식을 확인해 주세요. 키에 공백·줄바꿈이 들어갈 수 없습니다.");
        if (string.IsNullOrWhiteSpace(model) || model.Length > 100 || model.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-' && c != '.'))
            throw new ArgumentException("모델 ID를 확인해 주세요.");
        var input = new List<object>();
        if (draft.Source is { IsAttachment: true } source)
        {
            progress?.Report("원본 파일 확인"); var bytes = await FileImport.ReadSourceAsync(source, directory, token);
            input.Add(new { type = source.MimeType == "application/pdf" ? "document" : "image", mime_type = source.MimeType, data = Convert.ToBase64String(bytes) });
        }
        input.Add(new { type = "text", text = JsonSerializer.Serialize(new { title = draft.Title, body = draft.Body,
            suppliedAnswer = draft.Answer, suppliedExplanation = draft.Explanation, suppliedSteps = draft.Steps,
            note = draft.Source?.IsAttachment == true ? "파일에서 문제를 읽으세요. body는 추가 지시입니다." : "body가 현재 원문입니다. 수정된 내용은 이 본문을 사용하세요." }) });
        using var promptStream = typeof(GeminiGenerator).Assembly.GetManifestResourceStream("EduMaster.Core.Prompts.file-variant-v1.txt")!;
        using var reader = new StreamReader(promptStream); var prompt = await reader.ReadToEndAsync(token);
        var body = new { model, input, system_instruction = prompt, store = false,
            response_format = new { type = "text", mime_type = "application/json", schema = Schema(draft) },
            generation_config = new { max_output_tokens = 8192 } };
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://generativelanguage.googleapis.com/v1beta/interactions");
        request.Headers.Add("x-goog-api-key", apiKey.Trim()); request.Headers.Add("Api-Revision", "2026-05-20");
        request.Content = JsonContent.Create(body);
        progress?.Report("Gemini가 원문을 읽고 변형 문제 작성 중");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(response.StatusCode switch
        {
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => "Gemini 인증 실패 · API 키와 프로젝트 권한을 확인해 주세요.",
            HttpStatusCode.TooManyRequests => "Gemini 호출 한도 초과 · 결제/할당량을 확인하고 잠시 후 다시 시도해 주세요.",
            HttpStatusCode.NotFound or HttpStatusCode.BadRequest => "Gemini 요청 실패 · 모델 사용 가능 여부와 입력 파일을 확인해 주세요. 모델 ID는 AI 설정에서 변경할 수 있습니다.",
            _ => $"Gemini 응답 오류 ({(int)response.StatusCode}) · 입력은 유지됩니다. 잠시 후 다시 시도해 주세요."
        });
        var bytesResponse = await FileImport.ReadLimitedAsync(await response.Content.ReadAsStreamAsync(token), 1024 * 1024, token);
        progress?.Report("응답 형식과 원문 연결 확인");
        return ParseResponse(bytesResponse, draft, model);
    }
    public static SampleResult ParseResponse(byte[] response, ProblemDraft draft, string model)
    {
        try
        {
            using var envelope = JsonDocument.Parse(response); var root = envelope.RootElement;
            if (root.GetProperty("status").GetString() != "completed") throw new InvalidDataException("Gemini가 생성을 완료하지 못했습니다. 다시 시도해 주세요.");
            var text = string.Concat(root.GetProperty("steps").EnumerateArray()
                .Where(s => s.TryGetProperty("type", out var t) && t.GetString() == "model_output")
                .SelectMany(s => s.GetProperty("content").EnumerateArray())
                .Where(c => c.GetProperty("type").GetString() == "text").Select(c => c.GetProperty("text").GetString()));
            using var generated = JsonDocument.Parse(text); var v = generated.RootElement;
            if (v.GetProperty("status").GetString() == "unsupported")
                throw new UnsupportedProblemException("자료에서 문제를 만들지 못했습니다 · " + Required(v, "message", 1000));
            if (v.GetProperty("status").GetString() != "ready") throw new InvalidDataException("문항 응답 상태가 올바르지 않습니다.");
            var source = Required(v, "sourceProblem", 12000); var body = Required(v, "body", 12000);
            var compact = static (string s) => string.Concat(s.Where(c => !char.IsWhiteSpace(c)));
            if (compact(source) == compact(body)) throw new InvalidDataException("원문이 그대로 반환되었습니다. 새 변형으로 다시 생성해 주세요.");
            if (draft.Source?.IsAttachment != true && !compact(draft.Body).Contains(compact(source), StringComparison.Ordinal))
                throw new InvalidDataException("응답의 기준 문제가 입력 본문과 맞지 않습니다. 원문을 충실히 읽지 않은 결과를 표시하지 않습니다.");
            var choices = v.GetProperty("choices").EnumerateArray().Select(c => c.GetString()?.Trim() ?? "").ToArray();
            var steps = v.GetProperty("steps").EnumerateArray().Select(c => c.GetString()?.Trim() ?? "").ToArray();
            var answer = v.GetProperty("answerIndex").GetInt32();
            if (choices.Length != 5 || choices.Any(s => string.IsNullOrWhiteSpace(s) || s.Length > 3000) ||
                choices.Select(compact).Distinct().Count() != 5 || answer is < 0 or > 4 || steps.Length is < ProblemDraft.MinLogicSteps or > ProblemDraft.MaxLogicSteps || draft.UseSolutionLogic&&steps.Length!=draft.Steps.Length || steps.Any(s => string.IsNullOrWhiteSpace(s) || s.Length > 3000))
                throw new InvalidDataException("보기·정답·풀이 단계 형식이 올바르지 않습니다. 결과를 다시 생성해 주세요.");
            return new(Guid.NewGuid(), draft.Id, draft.Fingerprint(), Required(v, "title", 200), body, choices,
                new[] { "①", "②", "③", "④", "⑤" }[answer] + " " + choices[answer], Required(v, "explanation", 12000), steps, Required(v, "changeSummary", 3000))
            { GenerationNotice = "AI 초안 · 독립 검산·교사 확인 전", SourceProblem = Required(v, "sourceLocation", 200) + "\n" + source,
                Model = root.TryGetProperty("model", out var actualModel) ? actualModel.GetString() ?? model : model, PromptVersion = PromptVersion, UsageSummary = Usage(root) };
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        { throw new InvalidDataException("Gemini 응답을 읽지 못했습니다. 누락·잘린 응답은 결과로 사용하지 않습니다.", e); }
    }
    private static string Required(JsonElement v, string name, int limit)
    { var s = v.GetProperty(name).GetString(); return !string.IsNullOrWhiteSpace(s) && s.Length <= limit ? s.Trim() : throw new InvalidDataException("응답 필드가 비었거나 너무 깁니다: " + name); }
    private static string Usage(JsonElement root)
    {
        if (!root.TryGetProperty("usage", out var usage)) return "사용량 미제공 · 비용 미산정";
        return usage.TryGetProperty("total_tokens", out var total) ? $"총 {total} 토큰 · 비용 미산정" : "사용량 미제공 · 비용 미산정";
    }
    private static object Schema(ProblemDraft draft)
    {
        var properties = new Dictionary<string, object>();
        foreach (var name in new[] { "message", "sourceProblem", "sourceLocation", "title", "body", "explanation", "changeSummary" }) properties[name] = new { type = "string" };
        properties["status"] = new { type = "string", @enum = new[] { "ready", "unsupported" } };
        properties["choices"] = new { type = "array", minItems=5,maxItems=5,items = new { type = "string" } };
        properties["steps"] = new { type = "array", minItems=draft.UseSolutionLogic?draft.Steps.Length:ProblemDraft.MinLogicSteps,maxItems=draft.UseSolutionLogic?draft.Steps.Length:ProblemDraft.MaxLogicSteps,items = new { type = "string" } };
        properties["answerIndex"] = new { type = "integer" };
        return new { type = "object", properties, required = properties.Keys.ToArray() };
    }
}
public sealed class UnsupportedProblemException(string message) : Exception(message);
