using EduMaster.Core;
using System.Net;
using System.Text.Json;

namespace EduMaster.Core.Tests;

public sealed class VariantDesignPolicyTests
{
    [Fact]
    public void IntegratedFinalKeepsTeacherSolutionAndSkipsUniformNumberTemplate()
    {
        const string teacherMethod="문자 t를 먼저 도입해 각 실험의 비율을 하나의 식으로 묶는다.";
        var source=new ProblemDraft { Title="기준",Body=ReactionVariantPlanTests.Source,
            Answer="② 2/5",Explanation=teacherMethod,Steps=["t를 도입한다","질량을 정리한다","상댓값을 검산한다"],UseSolutionLogic=true };
        var final=LearningStagePlan.Build(source)[^1].Draft;
        Assert.Equal("integrated",final.VariantMode);
        Assert.True(final.SkipDeterministicPlan);
        Assert.False(final.IsPartialLearningStage);
        Assert.Equal(teacherMethod,final.Explanation);
        Assert.Contains("숫자만 일괄 변경하지",final.LogicScope);
        Assert.All(LearningStagePlan.Build(source)[..^1],stage=>Assert.True(stage.Draft.IsPartialLearningStage));
    }

    [Fact]
    public void NumericModeAllowsVerifiedTemplateButIntegratedModeRejectsIt()
    {
        var source=new ProblemDraft { Title="기준",Body=ReactionVariantPlanTests.Source,
            Answer="② 2/5",Explanation="원본 해설",Steps=["가정","질량","상댓값"],UseSolutionLogic=true };
        var template=ReactionVariantPlan.Create(source)!;
        var result=new SampleResult(Guid.NewGuid(),source.Id,source.Fingerprint(),"쌍둥이",template.Body,
            template.Choices,template.Answer,template.Solution.Explanation,template.Solution.Steps,"숫자 변형");
        Assert.Equal("fail",VariantDesignPolicy.Inspect(source,result)!.State);
        var numeric=source with { VariantMode="numeric" };
        Assert.Null(VariantDesignPolicy.Inspect(numeric,result));
        Assert.False(LearningStagePlan.Build(numeric)[^1].Draft.SkipDeterministicPlan);
        Assert.Throws<ArgumentException>(()=>(source with {VariantMode="unexpected"}).Validate());
    }
    [Fact]
    public void IntegratedReactionRejectsNonuniformNumbersAndPaddingWithSameResidualLayout()
    {
        var draft=new ProblemDraft{Body=ReactionVariantPlanTests.Source};
        const string variant="""
        A(g) + bB(g) → 2C(g) + 2D(g)
        반응 전과 반응 후 남은 A 또는 B의 질량을 표에 나타냈다.
        | 실험 | 반응 전 A 질량 | 반응 전 B 질량 | 반응 후 남은 A 또는 B의 질량 | D의 양/전체 기체의 양 (상댓값) |
        | I | 4w | 4w | 2w | x |
        | II | 7w | 12w | 1w | 6 |
        | III | 1w | 3w | 1w | 5 |
        (b/x) × (C의 몰질량 + D의 몰질량)/(B의 몰질량)은?
        """;
        var result=new SampleResult(Guid.NewGuid(),draft.Id,"","변형",variant,["1/5","2/5","3/5","4/5","1"],"③ 3/5","풀이",[],"다른 배수와 설명을 추가했다.");
        Assert.Contains("잔류 A/B 배치",VariantDesignPolicy.Inspect(draft,result)!.Evidence);
        Assert.Null(VariantDesignPolicy.Inspect(draft with{VariantMode="numeric"},result));
    }
    [Fact]
    public void IntegratedReactionAllowsChangedResidualAndRelativeValueDependencies()
    {
        var draft=new ProblemDraft{Body=ReactionVariantPlanTests.Source};
        const string variant="""
        A(g) + bB(g) → 2C(g) + 2D(g)
        반응 전과 반응 후 남은 A 또는 B의 질량을 표에 나타냈다.
        | 실험 | 반응 전 A 질량 | 반응 전 B 질량 | 반응 후 남은 A 또는 B의 질량 | D의 양/전체 기체의 양 (상댓값) |
        | I | 4w | 6w | 1w | 30 |
        | II | 3w | 8w | 2w | 26 |
        | III | 4w | 4w | 2w | x |
        (b/x) × (C의 몰질량 + D의 몰질량)/(B의 몰질량)은?
        """;
        Assert.Equal(27d/104,ReactionMassCheck.Solve(variant)!.Value,8);
        Assert.False(ReactionMassCheck.SameResidualLayout(draft.Body,variant));
        Assert.Equal("pass",ReactionMassCheck.InspectComparativeInference(variant)!.State);
        var result=new SampleResult(Guid.NewGuid(),draft.Id,"","변형",variant,[],"답","풀이",[],"자료 관계를 변경했다.");
        Assert.Equal("pass",VariantDesignPolicy.Inspect(draft,result)!.State);
    }

    [Fact]
    public void IndependentReactionCheckCanKeepTeacherMethod()
    {
        var source=new ProblemDraft {Title="기준",Body=ReactionVariantPlanTests.Source};
        var plan=ReactionVariantPlan.Create(source)!;
        var input=new SampleResult(Guid.NewGuid(),source.Id,source.Fingerprint(),"문항",plan.Body,
            plan.Choices,plan.Answer,"문자 t를 도입해 두 실험을 한 식으로 묶는다.",["t를 먼저 정의한다"],"변형");
        var checkedResult=ReactionMassCheck.Verify(input,preserveMethod:true);
        Assert.Equal(input.Explanation,checkedResult.Explanation);
        Assert.Equal(input.Steps,checkedResult.Steps);
        Assert.Equal(input.Answer,checkedResult.Answer);
    }

    [Fact]
    public void IntegratedFinalRejectsDroppedContradictionMethodAndRedundantCondition()
    {
        var source=new ProblemDraft{Title="기준",Body=ReactionVariantPlanTests.Source,
            Explanation="실험 간 소비 질량을 비교한다",Steps=["A 전량 반응을 가정해 두 실험의 소비 질량비 모순을 확인한다."]};
        var template=ReactionVariantPlan.Create(source)!;
        var result=new SampleResult(Guid.NewGuid(),source.Id,source.Fingerprint(),"변형",template.Body,
            template.Choices,template.Answer,"실험을 비교한다",["B가 반응한다"],"변형");
        Assert.Contains("가정",VariantDesignPolicy.Inspect(source,result)!.Evidence);
        var fixedMethod=result with{Steps=["A 전량 반응을 가정해 두 실험의 모순을 확인한다"],
            Body=template.Body+" 단, 온도와 압력은 일정하다."};
        Assert.Contains("온도",VariantDesignPolicy.Inspect(source,fixedMethod)!.Evidence);
    }

    [Fact]
    public void RedundantReactionContextIsRemovedOnlyAfterAnswerStaysTheSame()
    {
        var draft=new ProblemDraft{Title="기준",Body=ReactionVariantPlanTests.Source};
        var plan=ReactionVariantPlan.Create(draft)!;
        var result=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"변형",plan.Body+"\n(단, 실린더 속 기체의 온도와 압력은 일정하다.)",
            plan.Choices,plan.Answer,plan.Solution.Explanation,plan.Solution.Steps,"변형");
        var repaired=VariantDesignPolicy.RemoveRedundantReactionContext(draft,result);
        Assert.DoesNotContain("온도",repaired.Body);
        Assert.Equal(result.Answer,repaired.Answer);
        Assert.Equal(ReactionMassCheck.Solve(result.Body)!.Answer,ReactionMassCheck.Solve(repaired.Body)!.Answer);
    }

    [Fact]
    public void RedundantReactionContextIsRemovedWhenWrittenAsStandaloneSentence()
    {
        var draft=new ProblemDraft{Title="기준",Body=ReactionVariantPlanTests.Source};
        var plan=ReactionVariantPlan.Create(draft)!;
        var result=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"변형",
            plan.Body+"\n실린더 속 기체의 온도와 압력은 일정하다.",
            plan.Choices,plan.Answer,plan.Solution.Explanation,plan.Solution.Steps,"변형");
        var repaired=VariantDesignPolicy.RemoveRedundantReactionContext(draft,result);
        Assert.DoesNotContain("온도와 압력",repaired.Body);
        Assert.Equal(result.Answer,repaired.Answer);
    }

    [Fact]
    public void ReactionResidualHeaderNamesUnreactedSpeciesBeforeReview()
    {
        var draft=new ProblemDraft{Title="기준",Body=ReactionVariantPlanTests.Source};
        var plan=ReactionVariantPlan.Create(draft)!;
        var ambiguous=plan.Body.Replace("반응 후 남은 A 또는 B의 질량(g)","반응 후 잔류 질량(g)");
        Assert.NotEqual(plan.Body,ambiguous);
        var result=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"변형",ambiguous,
            plan.Choices,plan.Answer,plan.Solution.Explanation,plan.Solution.Steps,"변형");
        var clarified=VariantDesignPolicy.ClarifyReactionMassResidual(result);
        Assert.Contains("반응하지 않고 남은 A 또는 B의 질량",clarified.Body);
        Assert.DoesNotContain("반응 후 잔류 질량",clarified.Body);
        Assert.Equal(ReactionMassCheck.Solve(result.Body)!.Answer,ReactionMassCheck.Solve(clarified.Body)!.Answer);
    }

    [Fact]
    public void PartialExerciseCleanupKeepsHelperDefinitionsAndMassData()
    {
        var draft=new ProblemDraft{Body=ReactionVariantPlanTests.Source,IsPartialLearningStage=true};
        const string body="""
        A(g) + bB(g) → 2C(g) + 2D(g)
        | 실험 | 반응 전 A의 질량(g) | 반응 전 B의 질량(g) | 반응 후 남은 A 또는 B의 질량(g) |
        | I | 6w | 9w | 3w |
        | II | 3w | 6w | 1w |
        | III | 2w | 9w | 3w |
        실험 II에서 생성된 C와 D의 양의 합과 실험 III에서 남은 B의 양은?
        (단, A w g의 양을 n mol, B w g의 양을 m mol이라 한다. 온도와 압력은 일정하다.)
        """;
        var result=new SampleResult(Guid.NewGuid(),draft.Id,"","연습",body,[],"③ 8n mol, 3m mol","해설",[],"");
        var clean=VariantDesignPolicy.RemoveRedundantReactionContext(draft,result);
        Assert.DoesNotContain("온도와 압력",clean.Body);
        Assert.Contains("A w g의 양을 n mol, B w g의 양을 m mol이라 한다.",clean.Body);
        Assert.True(clean.Body.EndsWith(')'));
        Assert.Contains("| II | 3w | 6w | 1w |",clean.Body);
        Assert.Equal(result.Answer,clean.Answer);
        Assert.Equal("pass",ReactionMassCheck.InspectMassConditions(clean.Body)!.State);
        var joined=result with{Body=body.Replace("이라 한다. 온도", "이라 하고, 온도")};
        var cleanedJoined=VariantDesignPolicy.RemoveRedundantReactionContext(draft,joined);
        Assert.DoesNotContain("하고,)",cleanedJoined.Body);
        Assert.Contains("m mol이라 한다.)",cleanedJoined.Body);
        var alternateHeader=result with{Body=body.Replace("반응 후 남은 A 또는 B", "반응하지 않고 남은 A 또는 B")};
        Assert.DoesNotContain("온도와 압력",VariantDesignPolicy.RemoveRedundantReactionContext(draft,alternateHeader).Body);
    }

    [Fact]
    public void ReactionResidualClarificationRestoresMissingTableLineBreak()
    {
        var draft=new ProblemDraft{Title="기준",Body=ReactionVariantPlanTests.Source};
        var plan=ReactionVariantPlan.Create(draft)!;
        var glued=plan.Body.Replace("| 실험 |","반응 후 잔류 질량을 제시하였다.| 실험 |");
        Assert.NotEqual(plan.Body,glued);
        var result=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"변형",glued,
            plan.Choices,plan.Answer,plan.Solution.Explanation,plan.Solution.Steps,"변형");
        var clarified=VariantDesignPolicy.ClarifyReactionMassResidual(result);
        Assert.Contains("제시하였다.\n\n| 실험 |",clarified.Body);
        Assert.Equal(ReactionMassCheck.Solve(result.Body)!.Answer,ReactionMassCheck.Solve(clarified.Body)!.Answer);
    }

    [Fact]
    public async Task SolutionRepairKeepsTheAlreadyCheckedQuestionAndAnswer()
    {
        var draft=new ProblemDraft{Title="기준",Body=ReactionVariantPlanTests.Source,
            Steps=["한계 반응물을 가정하고 모순 판정","반응 후 몰수 정리","상댓값으로 최종값 계산"]};
        var plan=ReactionVariantPlan.Create(draft)!;
        var result=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"변형",plan.Body,
            plan.Choices,plan.Answer,"기존 풀이",["기존 단계 1","기존 단계 2","기존 단계 3"],"변형");
        using var http=new HttpClient(new MethodRepairHandler(result.Body,result.Answer));
        var repaired=await new DeepSeekVisualGenerator(http).RepairSolutionAsync(result,draft,"가정과 모순 판정 누락","test-only");
        Assert.Equal(result.Body,repaired.Body);
        Assert.Equal(result.Answer,repaired.Answer);
        Assert.Equal(result.Choices,repaired.Choices);
        Assert.Contains("모순",repaired.Steps[0]);
        Assert.Contains("STEP 1",repaired.Explanation);
    }

    private sealed class MethodRepairHandler(string expectedBody,string expectedAnswer):HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)
        {
            using var sent=JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            var source=sent.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!;
            using var materialInput=JsonDocument.Parse(source);
            Assert.Equal(expectedBody,materialInput.RootElement.GetProperty("question").GetString());
            Assert.Equal(expectedAnswer,materialInput.RootElement.GetProperty("Answer").GetString());
            var material=JsonSerializer.Serialize(new{explanation="STEP 1. 실험 I과 II에서 A가 모두 반응한다고 가정하면 소비 질량비가 달라 모순이다. STEP 2. 질량 보존으로 몰수를 구한다. STEP 3. 상대 몰비로 최종값을 구한다.",
                steps=new[]{"A가 모두 반응한다고 가정해 두 실험의 모순을 확인한다","반응 후 몰수 정리","상댓값으로 최종값 계산"}});
            return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(new{choices=new[]{new{finish_reason="stop",message=new{content=material}}}}))};
        }
    }
}
