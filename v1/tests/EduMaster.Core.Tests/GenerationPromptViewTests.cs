using System.Net;
using System.Text;
using System.Text.Json;
using EduMaster.Core;
using EduMaster.Web;

namespace EduMaster.Core.Tests;

public sealed class GenerationPromptViewTests
{
    [Fact]
    public void PreviewUsesGeneratorPromptsAndInputDependentPlaceholders()
    {
        var preview = GenerationPromptView.Get();
        Assert.Equal(VariantResponse.PromptVersion, preview.Version);
        Assert.Equal(6, preview.Variants.Length);
        foreach (var entry in preview.Variants)
        {
            Assert.NotEmpty(entry.Content);
            Assert.Contains("approvedTeacherFeedback", entry.Content);
            var draft = new ProblemDraft { Title = "입력 문제", Body = "분석된 문제 본문", Explanation = "입력 또는 생성된 기준 해설",
                UseSolutionLogic = true, Steps = ["실제 풀이 STEP"], VariantMode = entry.Mode == "numeric" ? "numeric" : "integrated", IsPartialLearningStage = entry.Mode == "practice" };
            if (entry.Provider == "gemma") Assert.Equal(LocalGemmaGenerator.BuildSystemPrompt(draft), entry.Content);
            else
            {
                Assert.Contains("{{이번 입력의 식별값}}", entry.Content);
                Assert.Contains("{{실제 풀이 STEP 수}}", entry.Content);
                Assert.DoesNotContain(draft.Fingerprint(), entry.Content);
                Assert.Equal(DeepSeekVisualGenerator.BuildSystemPrompt(draft)
                    .Replace(draft.Fingerprint(), "{{이번 입력의 식별값}}")
                    .Replace("같은 개수(1개)", "같은 개수({{실제 풀이 STEP 수}}개)"), entry.Content);
            }
        }
        Assert.NotEqual(preview.Variants.Single(v => v.Provider == "deepseek" && v.Mode == "integrated").Content,
            preview.Variants.Single(v => v.Provider == "deepseek" && v.Mode == "numeric").Content);
    }

    [Theory]
    [InlineData("integrated", false)]
    [InlineData("numeric", false)]
    [InlineData("integrated", true)]
    public async Task DisplayedPromptBuilderIsAlsoUsedByActualDeepSeekRequests(string mode, bool practice)
    {
        var draft = Draft(mode, practice);
        var handler = new CaptureHandler();
        using var client = new HttpClient(handler);
        var failure = await Record.ExceptionAsync(() => new DeepSeekVisualGenerator(client).GenerateAsync(draft, "fixture-key"));
        Assert.NotNull(failure);
        Assert.Equal(DeepSeekVisualGenerator.BuildSystemPrompt(draft), handler.SystemPrompt);
    }

    [Fact]
    public async Task DisplayedGemmaPromptBuilderIsUsedByActualRequestsAndRetryDiffers()
    {
        var draft = Draft("integrated", false);
        var handler = new CaptureHandler();
        using var client = new HttpClient(handler);
        var failure = await Record.ExceptionAsync(() => new LocalGemmaGenerator(client).GenerateAsync(draft, LocalGemmaGenerator.DefaultEndpoint));
        Assert.NotNull(failure);
        Assert.Equal(LocalGemmaGenerator.BuildSystemPrompt(draft), handler.SystemPrompt);
        Assert.NotEqual(LocalGemmaGenerator.BuildSystemPrompt(draft), LocalGemmaGenerator.BuildSystemPrompt(draft, true));
    }

    private static ProblemDraft Draft(string mode, bool practice) => new()
    {
        Title = "논리 문항", Body = "주어진 전제에서 결론을 판단하는 문항이다.", Explanation = "주어진 전제를 확인하여 결론을 판단한다.",
        Steps = ["전제 확인"], UseSolutionLogic = true, VariantMode = mode, IsPartialLearningStage = practice
    };

    private sealed class CaptureHandler : HttpMessageHandler
    {
        public string? SystemPrompt { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (request.Method == HttpMethod.Get)
                return new(HttpStatusCode.OK) { Content = new StringContent("{\"data\":[{\"id\":\"gemma-4-12b\",\"meta\":{\"n_ctx\":8192}}]}", Encoding.UTF8, "application/json") };
            using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            SystemPrompt ??= payload.RootElement.GetProperty("messages")[0].GetProperty("content").GetString();
            // This test captures the real request without making paid/model calls.
            return new(HttpStatusCode.BadRequest) { Content = new StringContent("{\"error\":\"fixture stops after capture\"}", Encoding.UTF8, "application/json") };
        }
    }
}
