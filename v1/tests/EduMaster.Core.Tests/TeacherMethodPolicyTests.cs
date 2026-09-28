using EduMaster.Core;

namespace EduMaster.Core.Tests;

public class TeacherMethodPolicyTests
{
    [Fact]
    public void PrintedMoleQuantityDefinitionsAreRecognizedAndStepDetailsAreRetained()
    {
        const string explanation="STEP 1. 한계 반응물\n만약 A가 모두 반응하면 주어진 자료와 맞지 않다.\nSTEP 2. 몰수 정리\nA w g의 양(mol)을 n, B w g의 양(mol)을 m이라 하면 반응량을 구한다.\nSTEP 3. 몰질량을 구한다.\n두 실험의 상댓값을 대조한다.";
        Assert.Equal(new[]{"n","m"},TeacherMethodPolicy.HelperVariables(explanation));
        var material=new ProblemSolutionMaterial("원본 문제","② 2/5",explanation,["한계 반응물","몰수","물질량"],[]);
        var enriched=TeacherMethodPolicy.EnrichReadSteps(material);
        Assert.Equal(3,enriched.Steps.Length);
        Assert.Contains("만약",enriched.Steps[0]);
        Assert.Contains("양(mol)을 n",enriched.Steps[1]);
        Assert.Contains("몰질량",enriched.Steps[2]);
        Assert.Equal(material.Explanation,enriched.Explanation);
    }
    [Fact]
    public void PartialStageKeepsDetailedTeacherCalculationsAndHelperDefinitions()
    {
        var source = new ProblemDraft { Title="기준", Body="조건을 비교하여 값을 구하시오.", UseSolutionLogic=true,
            Steps=["실험 비교", "n과 m으로 몰수 정리", "상댓값 계산"],
            Explanation="STEP 1. 두 실험의 소비 질량비를 비교하면 서로 달라 모순이다.\nSTEP 2. A w g을 n mol, B w g을 m mol이라 하면 생성물은 4n mol이다.\nSTEP 3. 상댓값을 대조하여 b를 구한다." };
        var stage=LearningStagePlan.Build(source)[1].Draft;
        Assert.Contains("A w g을 n mol, B w g을 m mol",stage.Explanation);
        Assert.DoesNotContain("STEP 3",stage.Explanation);
        Assert.Equal(new[]{"n","m"},TeacherMethodPolicy.HelperVariables(stage.Explanation));
    }

    [Fact]
    public void MissingTeacherHelperVariablesAreDetected()
    {
        var draft=new ProblemDraft{UseSolutionLogic=true,Explanation="A w g을 n mol, B w g을 m mol이라 하면 반응량을 정리할 수 있다."};
        var result=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"","문제","조건",[],"답","A가 t mol 반응한다.",["t를 계산"],"");
        Assert.Equal("fail",TeacherMethodPolicy.Inspect(draft,result)!.State);
        Assert.Equal("pass",TeacherMethodPolicy.Inspect(draft,result with{Explanation="A w g을 n mol, B w g을 m mol이라 놓고 새 수치로 계산한다."})!.State);
    }

    [Fact]
    public void SavedPartialResultUsesItsLearningScopeAndKeepsFullOriginal()
    {
        var result=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"","문제","일반 문제",["1","2","3","4","5"],"① 1","해설",["첫 단계"],"")
            {SourceExplanation="원본 전체 해설",SourceSteps=["첫 단계","둘째 단계","셋째 단계"],LearningSteps=["첫 단계"]};
        var report=ProblemQualityHarness.Inspect(result,partialLearningStage:true);
        Assert.Contains(report.Checks,c=>c.Id=="source-logic"&&c.State=="pass");
        Assert.Equal("원본 전체 해설",result.SourceExplanation);
    }

    [Fact]
    public void StoredPartialReferenceRetainsScopeAndStoredFinalKeepsDesignMode()
    {
        var result=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"","문제","조건",[],"답","해설",["단계 1","단계 2"],""){
            SourceProblem="원본",SourceExplanation="STEP 1. 비교\nSTEP 2. A w g을 n mol, B w g을 m mol이라 한다.\nSTEP 3. 상댓값을 계산한다.",
            SourceSteps=["비교","n과 m으로 정리","상댓값"],LearningSteps=["비교","n과 m으로 정리"],
            VariantMode="integrated",PriorStageIdeas="실제로 만든 앞 문제의 조건과 질문"};
        var partial=TeacherMethodPolicy.RestoreReference(result,true)!;
        Assert.Equal(result.LearningSteps,partial.Steps);
        Assert.Equal(new[]{"상댓값"},partial.ExcludedSteps);
        Assert.DoesNotContain("STEP 3",partial.Explanation);
        Assert.Equal("integrated",partial.VariantMode);
        Assert.Equal(result.PriorStageIdeas,partial.PriorStageIdeas);
        Assert.Equal("numeric",TeacherMethodPolicy.RestoreReference(result with{VariantMode="numeric"},false)!.VariantMode);
    }

    [Fact]
    public void EarlierIdeasContainActualQuestionAndSolutionRatherThanOnlyChangeSummary()
    {
        var result=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"","문제",new string('가',800)+"남는 기체를 구하시오.",[],"B","해설",["A가 전부 반응한다고 가정해 모순을 판정"],"질문 변경");
        var json=TeacherMethodPolicy.PriorIdeas(new[]{("STEP 1",result)});
        using var data=System.Text.Json.JsonDocument.Parse(json);
        Assert.Contains("남는 기체를 구하시오",data.RootElement[0].GetProperty("question").GetString());
        Assert.Contains("모순",data.RootElement[0].GetProperty("actualSolutionSteps")[0].GetString());
    }

    [Fact]
    public void InferredResidueAnnotationsDoNotBecomeGivenConditions()
    {
        var explanation="STEP 1. 만약 A가 모두 반응하면 두 실험의 자료와 맞지 않다.\nSTEP 2. 질량과 몰수를 구한다.\nSTEP 3. 상댓값을 대조한다.";
        var material=new ProblemSolutionMaterial(ReactionVariantPlanTests.Source,"② 2/5",explanation,["단계 1","단계 2","단계 3"],[]);
        var clean=TeacherMethodPolicy.EnrichReadSteps(material);
        Assert.DoesNotContain("| A (10/3)w |",clean.Body);
        Assert.Equal(ReactionMassCheck.Solve(material.Body)!.Answer,ReactionMassCheck.Solve(clean.Body)!.Answer);
        Assert.Equal(explanation,clean.Explanation);
        Assert.Contains(clean.Uncertainties,s=>s.Contains("문제 조건에서 제외"));
        var given=material with{Explanation=explanation.Replace("만약 A가 모두 반응하면 두 실험의 자료와 맞지 않다.","표에 주어진 잔류 기체를 확인한다.")};
        Assert.Equal(material.Body,TeacherMethodPolicy.EnrichReadSteps(given).Body);
    }

    [Fact]
    public void OriginalCrossExperimentContradictionCannotBecomeOneRowImpossibility()
    {
        Assert.True(TeacherMethodPolicy.RequiresCrossExperimentComparison("만약 Ⅰ에서 A가 모두 반응했다면 소비 질량비를 Ⅱ에 적용했을 때 주어진 자료와 맞지 않다."));
        Assert.False(TeacherMethodPolicy.RequiresCrossExperimentComparison("Ⅰ에서 A가 모두 반응했다고 가정하면 남은 B가 음수가 되어 불가능하다."));
        const string shortcut="""
        A(g) + bB(g) → 2C(g) + 2D(g)
        | I | 3w | 1w | 2w |
        | II | 4w | 2w | 2w |
        | III | 2w | 4w | 2w |
        """;
        Assert.Equal("fail",ReactionMassCheck.InspectComparativeInference(shortcut)!.State);
        Assert.Equal("pass",ReactionMassCheck.InspectComparativeInference(ReactionVariantPlanTests.Source)!.State);
    }

    [Fact]
    public void HelperIntroductionAndRelativeValueCalculationCannotMoveToEarlierSteps()
    {
        var draft=new ProblemDraft{UseSolutionLogic=true,Steps=["비교","몰수","상댓값"],
            Explanation="STEP 1. 두 실험을 질량으로 비교한다.\nSTEP 2. A w g의 양(mol)을 n, B w g의 양(mol)을 m이라 한다.\nSTEP 3. 상댓값으로 몰분율과 b를 구한다."};
        var result=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"","문제","조건",[],"답",
            "STEP 1. A를 n mol, B를 m mol이라 하고 판별한다.\nSTEP 2. 생성물 몰수를 구한다.\nSTEP 3. 상댓값을 대조한다.",["판별","몰수","상댓값"],"");
        Assert.Contains("STEP 1",TeacherMethodPolicy.InspectOrder(draft,result)!.Evidence);
        var shifted=result with{Explanation="STEP 1. 질량을 비교한다.\nSTEP 2. A는 n mol, B는 m mol이다. 상댓값으로 b를 구한다.\nSTEP 3. 최종값을 구한다."};
        Assert.Contains("상댓값",TeacherMethodPolicy.InspectOrder(draft,shifted)!.Evidence);
    }
}
