using EduMaster.Core;
using EduMaster.Web;

namespace EduMaster.Core.Tests;

public sealed class GenerationGuidanceStoreTests
{
    [Fact]
    public async Task GlobalDoAndDontGuidancePersistsAndBuildsGenerationContext()
    {
        var directory = Path.Combine(Path.GetTempPath(), "edumaster-guidance-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new GenerationGuidanceStore(directory);
            Assert.Equal("", store.BuildPrompt());
            await store.SaveAsync("  풀이 단계마다 근거 식을 적는다  ", "무관한 조건을 덧붙이지 않는다");
            var restored = new GenerationGuidanceStore(directory);
            Assert.Equal("풀이 단계마다 근거 식을 적는다", restored.Get().Do);
            Assert.Contains("해야 할 것:\n풀이 단계마다 근거 식을 적는다", restored.BuildPrompt());
            Assert.Contains("하지 말아야 할 것:\n무관한 조건을 덧붙이지 않는다", restored.BuildPrompt());
            await Assert.ThrowsAsync<ArgumentException>(() => restored.SaveAsync(new string('가', 3001), ""));
            Assert.NotNull(restored.Get().UpdatedAt);
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task OriginalQuestionAndSolutionPagesSurviveArchiveRestart()
    {
        var directory = Path.Combine(Path.GetTempPath(), "edumaster-originals-" + Guid.NewGuid().ToString("N"));
        try
        {
            var archive = new LearningArchive(directory);
            var result = new SampleResult(Guid.NewGuid(), Guid.NewGuid(), "source", "원본 대조", "변형 문제 본문", [], "①", "변형 해설", [], "변형")
                { SourceProblem = "원본 문제 본문", SourceExplanation = "원본 해설", SourceAnswer = "②" };
            var job = new GenerationJob { State = "ready", Finished = true, Outputs = [new ProviderJob("deepseek", 1, 1, "쌍둥이") { State = "ready", Result = result }] };
            var jobId = Guid.NewGuid().ToString("N");
            await archive.ImportAsync(jobId, job);
            var pages = new[] { new VisualPage([1, 2], "image/png", 1) { MaterialRole = "question" }, new VisualPage([3, 4], "image/jpeg", 2) { MaterialRole = "solution" } };
            await archive.SaveOriginalPagesAsync(jobId, pages);
            var restored = new LearningArchive(directory);
            Assert.Equal("원본 해설", restored.Get(result.Id.ToString("N"))!.Result.SourceExplanation);
            Assert.Equal(new[] { "question", "solution" }, restored.GetOriginalPages(jobId).Select(x => x.MaterialRole));
            Assert.Equal(new byte[] { 3, 4 }, restored.GetOriginalPages(jobId)[1].Bytes);
            Assert.Empty(restored.GetOriginalPages(Guid.NewGuid().ToString("N")));
        }
        finally { Directory.Delete(directory, true); }
    }
}
