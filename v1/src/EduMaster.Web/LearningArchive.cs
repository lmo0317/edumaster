using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using EduMaster.Core;

namespace EduMaster.Web;

public sealed record LearningFeedback(string Id, string Category, string Issue, string Correction,
    string Status, DateTime CreatedAt, DateTime? ReviewedAt, string? Target = null);
public sealed record LearningProblem(string Id, string JobId, int StageNumber, string StageLabel,
    DateTime CreatedAt, SampleResult Result, LearningFeedback[] Feedback, string? ReportId = null,
    bool AddedManually = false, string? PdfReportId = null);
public sealed record LearningSummary(string Id, string JobId, int StageNumber, string StageLabel,
    DateTime CreatedAt, string Title, string Model, string QualityState, int FeedbackCount, int ApprovedCount,
    string? ReportId = null, string? PdfReportId = null);
public sealed record LearnedContent(string FeedbackId, string ProblemId, string ProblemTitle, string StageLabel,
    string Category, string Issue, string Correction, DateTime ReviewedAt, string Scope, string? Target = null);

public sealed class LearningArchive
{
    private readonly string directory;
    private readonly SemaphoreSlim gate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly Regex IdPattern = new("^[a-f0-9]{32}$", RegexOptions.Compiled);
    private static readonly Regex Words = new("[가-힣A-Za-z0-9]{2,}", RegexOptions.Compiled);
    private static readonly HashSet<string> StopWords = ["문제", "다음", "대한", "것은", "있는", "계산", "풀이", "단계", "해설", "정답", "실험", "조건"];

    public LearningArchive(string directory) { this.directory = directory; Directory.CreateDirectory(directory); }

    public LearningSummary[] List() => Directory.EnumerateFiles(directory, "*.json")
        .Select(Read).Where(x => x?.AddedManually == true).Cast<LearningProblem>()
        .OrderByDescending(x => x.CreatedAt)
        .Select(x => new LearningSummary(x.Id, x.JobId, x.StageNumber, x.StageLabel, x.CreatedAt,
            x.Result.Title, x.Result.Model, x.Result.Quality?.State ?? "unknown", x.Feedback.Length,
            x.Feedback.Count(f => f.Status == "approved"), x.ReportId, x.PdfReportId)).ToArray();

    public LearningProblem? Get(string id) => IdPattern.IsMatch(id) && Read(Path.Combine(directory, id + ".json")) is { AddedManually: true } entry ? entry : null;

    public LearnedContent[] ListLearned() => Directory.EnumerateFiles(directory, "*.json")
        .Select(Read).Where(x => x?.AddedManually == true).Cast<LearningProblem>()
        .SelectMany(problem => problem.Feedback.Where(feedback => feedback.Status == "approved")
            .Select(feedback => new LearnedContent(feedback.Id, problem.Id, problem.Result.Title,
                problem.StageLabel, feedback.Category, feedback.Issue, feedback.Correction,
                feedback.ReviewedAt ?? feedback.CreatedAt,
                feedback.Category == "method" ? "풀이 방식 선호 · 관련 있을 때 참고" : "유사 문제에서 참고",
                FeedbackTarget(feedback))))
        .OrderByDescending(content => content.ReviewedAt).ToArray();

    public async Task DeleteAsync(string id, CancellationToken token = default)
    {
        if (!IdPattern.IsMatch(id)) throw new ArgumentException("문제 번호가 올바르지 않습니다.");
        await gate.WaitAsync(token);
        try
        {
            var path = Path.Combine(directory, id + ".json");
            if (Read(path) is not { AddedManually: true }) throw new KeyNotFoundException("저장된 문제를 찾지 못했습니다.");
            // The marker prevents a job-cache or saved-PDF backfill from recreating deleted feedback.
            await File.WriteAllTextAsync(Path.Combine(directory, id + ".deleted"), DateTime.UtcNow.ToString("O"), token);
            File.Delete(path);
        }
        finally { gate.Release(); }
    }

    public Task StageAsync(string jobId, GenerationJob job, CancellationToken token = default) =>
        ImportAsync(jobId, job, token, addedManually: false);

    public async Task ImportAsync(string jobId, GenerationJob job, CancellationToken token = default, bool addedManually = true, string? pdfReportId = null)
    {
        if (!IdPattern.IsMatch(jobId)) throw new ArgumentException("작업 번호가 올바르지 않습니다.");
        ValidatePdfId(pdfReportId);
        if (job.State != "ready" || job.Outputs.Length == 0 || job.Outputs.Any(o => o.State != "ready" || o.Result is null))
            throw new InvalidOperationException("모든 단계의 결과가 완성된 뒤 학습 데이터로 추가해 주세요.");
        foreach (var output in job.Outputs.Where(o => o.Result is not null))
        {
            var result = output.Result!;
            var id = result.Id.ToString("N");
            var path = Path.Combine(directory, id + ".json");
            var compact = result with { Figures = [], VisualContexts = [] };
            var entry = new LearningProblem(id, jobId, output.StageNumber, output.StageLabel,
                job.Created, compact, [], AddedManually: addedManually, PdfReportId: pdfReportId);
            await gate.WaitAsync(token);
            try
            {
                if (File.Exists(Path.Combine(directory, id + ".deleted"))) continue;
                var existing = Read(path);
                if (existing is null) await WriteAsync(path, entry, token);
                else if (addedManually && (!existing.AddedManually || pdfReportId is not null))
                    await WriteAsync(path, existing with { AddedManually = true, PdfReportId = pdfReportId ?? existing.PdfReportId }, token);
            }
            finally { gate.Release(); }
        }
    }

    public bool HasJob(string jobId) => IdPattern.IsMatch(jobId) && List().Any(item => item.JobId == jobId);

    public string? GetPdfReportId(string jobId) => IdPattern.IsMatch(jobId)
        ? List().FirstOrDefault(item => item.JobId == jobId && item.ReportId is null && item.PdfReportId is not null)?.PdfReportId : null;

    private static void ValidatePdfId(string? id)
    {
        if (id is not null && !IdPattern.IsMatch(id)) throw new ArgumentException("PDF 번호가 올바르지 않습니다.");
    }

    public async Task SaveOriginalPagesAsync(string jobId, VisualPage[] pages, CancellationToken token = default)
    {
        if (!IdPattern.IsMatch(jobId)) throw new ArgumentException("작업 번호가 올바르지 않습니다.");
        if (!HasJob(jobId)) throw new KeyNotFoundException("학습 세트를 찾지 못했습니다.");
        if (pages.Length is < 1 or > 5 || pages.Any(page => page.Bytes.Length == 0 || page.MimeType is not ("image/png" or "image/jpeg")) || pages.Sum(page => (long)page.Bytes.Length) > FileImport.MaxBytes)
            throw new ArgumentException("원본 이미지 형식을 확인하지 못했습니다.");
        var originals = Path.Combine(directory, "original-images");
        Directory.CreateDirectory(originals);
        var path = Path.Combine(originals, jobId + ".json");
        var temporary = path + ".tmp";
        await gate.WaitAsync(token);
        try
        {
            await File.WriteAllBytesAsync(temporary, JsonSerializer.SerializeToUtf8Bytes(pages, new JsonSerializerOptions(Json) { IgnoreReadOnlyProperties = true }), token);
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); gate.Release(); }
    }

    public VisualPage[] GetOriginalPages(string jobId)
    {
        if (!IdPattern.IsMatch(jobId) || !HasJob(jobId)) return [];
        var path = Path.Combine(directory, "original-images", jobId + ".json");
        if (!File.Exists(path) || new FileInfo(path).Length > 15 * 1024 * 1024) return [];
        try { return JsonSerializer.Deserialize<VisualPage[]>(File.ReadAllBytes(path), Json) ?? []; }
        catch (JsonException) { return []; }
    }

    public async Task<int> PromoteStagedJobAsync(string jobId, CancellationToken token = default, string? pdfReportId = null)
    {
        if (!IdPattern.IsMatch(jobId)) throw new ArgumentException("작업 번호가 올바르지 않습니다.");
        ValidatePdfId(pdfReportId);
        await gate.WaitAsync(token);
        try
        {
            var entries = Directory.EnumerateFiles(directory, "*.json").Select(Read)
                .Where(entry => entry?.JobId == jobId && entry.ReportId is null).Cast<LearningProblem>().ToArray();
            if (entries.Length == 0) return 0;
            foreach (var entry in entries.Where(entry => !entry.AddedManually || pdfReportId is not null))
                await WriteAsync(Path.Combine(directory, entry.Id + ".json"), entry with { AddedManually = true, PdfReportId = pdfReportId ?? entry.PdfReportId }, token);
            return entries.Length;
        }
        finally { gate.Release(); }
    }

    public async Task UpdateResultAsync(SampleResult result, CancellationToken token = default)
    {
        var path = Path.Combine(directory, result.Id.ToString("N") + ".json");
        await gate.WaitAsync(token);
        try
        {
            var entry = Read(path);
            if (entry is not null && entry.ReportId is null)
                await WriteAsync(path, entry with { Result = result with { Figures = [], VisualContexts = [] } }, token);
        }
        finally { gate.Release(); }
    }

    public async Task<LearningFeedback> AddFeedbackAsync(string problemId, string category, string issue,
        string correction, string target = "problem", CancellationToken token = default)
    {
        if (!IdPattern.IsMatch(problemId)) throw new ArgumentException("문제 번호가 올바르지 않습니다.");
        category = category.Trim(); issue = issue.Trim(); correction = correction.Trim();
        target = target.Trim();
        if (category is not ("condition" or "answer" or "solution" or "method" or "visual" or "wording" or "other")
            || target is not ("problem" or "explanation") || issue.Length is < 5 or > 2000 || correction.Length is < 5 or > 3000)
            throw new ArgumentException("오류 내용과 올바른 수정 방향을 각각 5자 이상 입력해 주세요.");
        await gate.WaitAsync(token);
        try
        {
            var path = Path.Combine(directory, problemId + ".json");
            var entry = Get(problemId) ?? throw new KeyNotFoundException("저장된 문제를 찾지 못했습니다.");
            var feedback = new LearningFeedback(Guid.NewGuid().ToString("N"), category, issue, correction,
                "pending", DateTime.UtcNow, null, target);
            await WriteAsync(path, entry with { Feedback = [.. entry.Feedback, feedback] }, token);
            return feedback;
        }
        finally { gate.Release(); }
    }

    public async Task<LearningFeedback> ReviewAsync(string problemId, string feedbackId, bool approve,
        CancellationToken token = default)
    {
        if (!IdPattern.IsMatch(problemId) || !IdPattern.IsMatch(feedbackId))
            throw new ArgumentException("피드백 번호가 올바르지 않습니다.");
        await gate.WaitAsync(token);
        try
        {
            var path = Path.Combine(directory, problemId + ".json");
            var entry = Get(problemId) ?? throw new KeyNotFoundException("저장된 문제를 찾지 못했습니다.");
            var index = Array.FindIndex(entry.Feedback, f => f.Id == feedbackId);
            if (index < 0) throw new KeyNotFoundException("피드백을 찾지 못했습니다.");
            if (entry.Feedback[index].Status != "pending") throw new ArgumentException("이미 검토된 피드백입니다.");
            var reviewed = entry.Feedback[index] with { Status = approve ? "approved" : "rejected", ReviewedAt = DateTime.UtcNow };
            var feedback = (LearningFeedback[])entry.Feedback.Clone(); feedback[index] = reviewed;
            await WriteAsync(path, entry with { Feedback = feedback }, token);
            return reviewed;
        }
        finally { gate.Release(); }
    }

    public string Retrieve(ProblemDraft draft, int maxExamples = 3)
    {
        var query = Terms(draft.Body);
        var entries=Directory.EnumerateFiles(directory,"*.json").Select(Read).Where(x=>x?.AddedManually == true).Cast<LearningProblem>().ToArray();
        var teacherMethods=entries.SelectMany(entry=>entry.Feedback.Where(f=>f.Status=="approved"&&f.Category=="method")
                .Select(feedback=>new{entry.Result.Title,Feedback=feedback}))
            .OrderByDescending(x=>x.Feedback.ReviewedAt).Take(3).ToArray();
        var matches = entries
            .Select(x => new { Entry = x, Approved = x.Feedback.Where(f => f.Status == "approved").ToArray(),
                Score = Similarity(query, Terms(x.Result.SourceProblem.Length > 0 ? x.Result.SourceProblem : x.Result.Body)) })
            .Where(x => x.Approved.Length > 0 && x.Score >= 0.18)
            .OrderByDescending(x => x.Score).ThenByDescending(x => x.Entry.CreatedAt)
            .Take(Math.Clamp(maxExamples, 1, 5)).ToArray();
        if (matches.Length == 0&&teacherMethods.Length==0) return "";
        var lines = new List<string>();
        if(teacherMethods.Length>0){
            lines.Add("[교사가 승인한 풀이 방식 선호 — 현재 문제에 맞는 경우에만 적용한다. 이전 문항의 수치·정답·기호를 복사하지 않는다.]");
            foreach(var method in teacherMethods)lines.Add($"- 유형: {Trim(method.Title,80)} / 대상: {FeedbackTarget(method.Feedback)} / 개선할 점: {Trim(method.Feedback.Issue,350)} / 원하는 풀이: {Trim(method.Feedback.Correction,550)}");
        }
        if(matches.Length>0)lines.Add("[교사가 승인한 유사 문항 피드백 — 참고 사례. 현재 입력의 조건·독립 검산이 항상 우선이며, 이전 문항의 수치·정답을 복사하지 않는다.]");
        foreach (var match in matches)
        {
            lines.Add($"유형: {Trim(match.Entry.Result.Title, 100)} / 단계: {Trim(match.Entry.StageLabel, 50)}");
            foreach (var feedback in match.Approved.Take(3))
                if(!teacherMethods.Any(method=>method.Feedback.Id==feedback.Id))
                lines.Add($"- [{FeedbackTarget(feedback)} · {feedback.Category}] 개선할 점: {Trim(feedback.Issue, 500)} / 교사가 원하는 방법: {Trim(feedback.Correction, 700)}");
        }
        return Trim(string.Join("\n", lines), 4000);
    }

    public static string Digest(string context) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(context)));
    private static string FeedbackTarget(LearningFeedback feedback) => feedback.Target is "problem" or "explanation"
        ? feedback.Target : feedback.Category is "answer" or "solution" or "method" ? "explanation" : "problem";
    private static HashSet<string> Terms(string text) => Words.Matches(text.ToLowerInvariant()).Select(m => m.Value)
        .Where(w => w.Length >= 2 && !StopWords.Contains(w)).ToHashSet(StringComparer.Ordinal);
    private static double Similarity(HashSet<string> a, HashSet<string> b)
    {
        if (a.Count == 0 || b.Count == 0) return 0;
        return (double)a.Count(b.Contains) / Math.Min(a.Count, b.Count);
    }
    private static string Trim(string value, int max) => value.Length <= max ? value : value[..max];
    private static LearningProblem? Read(string path)
    {
        try
        {
            if (File.Exists(Path.ChangeExtension(path, ".deleted")) || !File.Exists(path) || new FileInfo(path).Length > 3_000_000) return null;
            var entry = JsonSerializer.Deserialize<LearningProblem>(File.ReadAllText(path), Json);
            return entry is not null && entry.Id == Path.GetFileNameWithoutExtension(path) && entry.Feedback is not null ? entry : null;
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException) { return null; }
    }
    private static async Task WriteAsync(string path, LearningProblem entry, CancellationToken token)
    {
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(entry, Json);
            if (bytes.Length > 3_000_000) throw new IOException("학습 문제 저장 크기를 초과했습니다.");
            await File.WriteAllBytesAsync(temp, bytes, token);
            File.Move(temp, path, true);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
