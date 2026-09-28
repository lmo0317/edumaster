using EduMaster.Core;

namespace EduMaster.Web;

public sealed record GenerationPromptVariant(string Provider, string Model, string Mode, string Content);
public sealed record GenerationPromptPreview(string Version, GenerationPromptVariant[] Variants);

public static class GenerationPromptView
{
    public static GenerationPromptPreview Get()
    {
        var variants = new List<GenerationPromptVariant>();
        foreach (var mode in new[] { "integrated", "numeric", "practice" })
        {
            var draft = new ProblemDraft
            {
                Title = "입력 문제", Body = "분석된 문제 본문", Explanation = "입력 또는 생성된 기준 해설",
                UseSolutionLogic = true, Steps = ["실제 풀이 STEP"],
                VariantMode = mode == "numeric" ? "numeric" : "integrated", IsPartialLearningStage = mode == "practice"
            };
            // Show input-dependent placeholders rather than a fabricated fixed three-STEP problem.
            var deepseek = DeepSeekVisualGenerator.BuildSystemPrompt(draft)
                .Replace(draft.Fingerprint(), "{{이번 입력의 식별값}}")
                .Replace($"같은 개수({draft.Steps.Length}개)", "같은 개수({{실제 풀이 STEP 수}}개)");
            variants.Add(new("deepseek", DeepSeekVisualGenerator.DisplayName, mode, deepseek));
            variants.Add(new("gemma", "Gemma 4 12B", mode, LocalGemmaGenerator.BuildSystemPrompt(draft)));
        }
        return new(VariantResponse.PromptVersion, variants.ToArray());
    }
}
