using System.Text.Json;

namespace EduMaster.Core;

public sealed record WorkspaceState(ProblemDraft Draft, SampleResult? Result, int Variation, DateTimeOffset SavedAt);

public sealed class StateStore(string directory)
{
    public string FilePath { get; } = Path.Combine(directory, "workspace.json");
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };

    public async Task<WorkspaceState?> LoadAsync()
    {
        if (!File.Exists(FilePath)) return null;
        await using var stream = File.OpenRead(FilePath);
        var state = await JsonSerializer.DeserializeAsync<WorkspaceState>(stream, Options)
            ?? throw new InvalidDataException("저장 자료가 비어 있습니다.");
        if (state.Draft is null) throw new InvalidDataException("기준 문제 자료가 없습니다.");
        state.Draft.Validate();
        ValidateResult(state.Result);
        return state.Result is not null && state.Result.InputFingerprint != state.Draft.Fingerprint()
            ? state with { Result = null } : state;
    }

    public async Task SaveAsync(WorkspaceState state)
    {
        state.Draft.Validate();
        ValidateResult(state.Result);
        if (state.Result is not null && state.Result.InputFingerprint != state.Draft.Fingerprint())
            throw new InvalidDataException("입력이 변경되어 결과를 다시 생성해야 합니다.");
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        var temporary = FilePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(state, Options));
            File.Move(temporary, FilePath, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private static void ValidateResult(SampleResult? result)
    {
        if (result is null) return;
        if (string.IsNullOrWhiteSpace(result.Title) || string.IsNullOrWhiteSpace(result.Body) || string.IsNullOrWhiteSpace(result.Answer)
            || result.Explanation is null || result.ChangeSummary is null || result.GenerationNotice is null || result.SourceProblem is null || result.Model is null
            || result.Choices is not { Length: 5 } || result.Choices.Any(string.IsNullOrWhiteSpace)
            || result.Steps is null || result.Steps.Length is < ProblemDraft.MinLogicSteps or > ProblemDraft.MaxLogicSteps || result.Steps.Any(string.IsNullOrWhiteSpace))
            throw new InvalidDataException("저장된 결과 형식이 올바르지 않습니다. 원본 파일을 복구해 주세요.");
    }
}
