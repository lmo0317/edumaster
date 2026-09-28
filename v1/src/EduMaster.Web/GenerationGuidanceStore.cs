using System.Text.Json;

namespace EduMaster.Web;

public sealed record GenerationGuidance(string Do, string Dont, DateTime? UpdatedAt = null);

public sealed class GenerationGuidanceStore
{
    private readonly string path;
    private readonly SemaphoreSlim gate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public GenerationGuidanceStore(string directory)
    {
        Directory.CreateDirectory(directory);
        path = Path.Combine(directory, "generation-guidance.json");
    }

    public GenerationGuidance Get()
    {
        if (!File.Exists(path)) return new("", "");
        try { return JsonSerializer.Deserialize<GenerationGuidance>(File.ReadAllBytes(path), Json) ?? new("", ""); }
        catch (JsonException) { return new("", ""); }
    }

    public async Task<GenerationGuidance> SaveAsync(string? doText, string? dontText, CancellationToken token = default)
    {
        doText = (doText ?? "").Trim();
        dontText = (dontText ?? "").Trim();
        if (doText.Length > 3000 || dontText.Length > 3000)
            throw new ArgumentException("해야 할 것과 하지 말아야 할 것은 각각 3,000자 이내로 작성해 주세요.");
        var guidance = new GenerationGuidance(doText, dontText, DateTime.UtcNow);
        await gate.WaitAsync(token);
        try
        {
            var temporary = path + ".tmp";
            try
            {
                await File.WriteAllBytesAsync(temporary, JsonSerializer.SerializeToUtf8Bytes(guidance, Json), token);
                File.Move(temporary, path, true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        finally { gate.Release(); }
        return guidance;
    }

    public string BuildPrompt()
    {
        var guidance = Get();
        if (guidance.Do.Length == 0 && guidance.Dont.Length == 0) return "";
        return "[관리자가 저장한 전체 문제 생성 지침 — 모든 유형에 적용. 원본 조건·독립 검산·출력 형식은 우선한다.]\n"
            + (guidance.Do.Length > 0 ? "해야 할 것:\n" + guidance.Do + "\n" : "")
            + (guidance.Dont.Length > 0 ? "하지 말아야 할 것:\n" + guidance.Dont : "");
    }
}
