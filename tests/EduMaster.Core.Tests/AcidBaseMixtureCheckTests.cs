using EduMaster.Core;

namespace EduMaster.Core.Tests;

public class AcidBaseMixtureCheckTests
{
    private const string Source = """
다음은 H₂X(aq), Y(OH)₂(aq), ZOH(aq)를 혼합한 용액 (가), (나)에 대한 자료이다.
| 혼합 용액 | (가) | (나) |
|---|---|---|
| 혼합 전 수용액의 부피 (mL) | 0.5 M H₂X(aq) | 30 | 30 |
| | a M Y(OH)₂(aq) | 10 | 15 |
| | b M ZOH(aq) | 0 | 15 |
| H⁺ 또는 OH⁻의 몰 농도(M) | 1/4 | x |
○ (가)에서 (모든 음이온의 몰 농도(M) 합)/(모든 양이온의 몰 농도(M) 합) > 1이다.
○ 모든 양이온의 양(mol)은 (가) : (나) = 4 : 9이다.
x는?
① 1/4 ② 3/4 ③ 5/6 ④ 7/6 ⑤ 4/3
""";

    private const string BadStage = """
다음은 H₂X(aq), Y(OH)₂(aq), ZOH(aq)를 혼합한 용액 (가), (나)에 대한 자료이다.
| 혼합 용액 | (가) | (나) |
|---|---|---|
| 혼합 전 수용액의 부피 (mL) | 0.8 M H₂X(aq) | 25 | 25 |
| | a M Y(OH)₂(aq) | 15 | 20 |
| | b M ZOH(aq) | 0 | 15 |
| H⁺ 또는 OH⁻의 몰 농도(M) | 1/4 | - |
○ (가)에서 (모든 음이온의 몰 농도(M) 합)/(모든 양이온의 몰 농도(M) 합) > 1이다.
○ 모든 양이온의 양(mol)은 (가) : (나) = 1 : 2이다.
b는?
""";

    private static SampleResult Result(string body,string answer,string explanation,string[]? choices=null)=>
        new(Guid.NewGuid(),Guid.NewGuid(),"fixture","산 염기 혼합",body,
            choices??["1/4","3/4","5/6","7/6","4/3"],answer,explanation,["이온 수 계산"],"연습");

    [Fact] public void SolvesOriginalFromIonCountWithoutTrustingIncorrectAnswerKey()
    {
        var solved=AcidBaseMixtureCheck.SolveSource(Source)!;
        Assert.StartsWith("② 3/4",solved.Answer);
        Assert.Contains("a=2",solved.Explanation);
        Assert.Contains("b=1",solved.Explanation);
        Assert.Contains("x=3/4",solved.Explanation);
    }

    [Fact] public void RejectsSourceAnswerThatContradictsOriginalTable()
    {
        var result=Result(Source,"④ 7/6","(가)에서 H⁺가 남는다.") with {
            SourceProblem=Source,SourceAnswer="④ 7/6",SourceExplanation="(가)에서 H⁺가 남는다."
        };
        Assert.Equal("fail",AcidBaseMixtureCheck.InspectSource(result)!.State);
    }

    [Fact] public void CorrectsMisreadImageSolutionBeforeStagePlanning()
    {
        var material=new ProblemSolutionMaterial(Source,"④ 7/6","(가)는 산성이다.",["산성 가정","보기 오류 추정"],[]);
        var corrected=material.WithVerifiedLogic();
        Assert.Equal("② 3/4",corrected.Answer);
        Assert.Equal(3,corrected.Steps.Length);
        Assert.Contains("염기성",corrected.Explanation);
    }

    [Fact] public void RejectsStageWithNoMatchingChoiceAfterChargeBalance()
    {
        var check=AcidBaseMixtureCheck.Inspect(Result(BadStage,"④ 2","a=1인 산성 용액이다.",
            ["1/2","1","3/2","2","5/2"]))!;
        Assert.Equal("fail",check.State);
        Assert.Contains("보기",check.Evidence);
    }

    [Fact] public void AcceptsCorrectOriginalAndRejectsWrongTwinAnswer()
    {
        Assert.Equal("pass",AcidBaseMixtureCheck.Inspect(Result(Source,"② 3/4","(가)는 염기성이고 a=2, b=1, x=3/4이다."))!.State);
        Assert.Equal("fail",AcidBaseMixtureCheck.Inspect(Result(Source,"④ 7/6","(가)는 염기성이다."))!.State);
    }

    [Fact] public void RejectsCorrectChoiceWithContradictoryIntermediateCalculation()
    {
        var check=AcidBaseMixtureCheck.Inspect(Result(Source,"② 3/4","(가)는 산성이라 a=1이고, x=3/4이다."))!;
        Assert.Equal("fail",check.State);
    }

    [Fact] public void DoesNotMistakeRejectedAcidicHypothesisForFinalConclusion()
    {
        var explanation="만약 H⁺가 남으면 음이온 몰수는 양이온 몰수보다 작아 >1 조건에 모순이다. 따라서 (가)에서는 OH⁻가 남는다. a=2, b=1, x=3/4이다.";
        Assert.Equal("pass",AcidBaseMixtureCheck.Inspect(Result(Source,"② 3/4",explanation))!.State);
    }

    [Fact] public void IndependentlyChecksSourceEvenWhenPartialStageOmitsSourceAnswer()
    {
        var stage=Result(BadStage,"④ 2","a=1이다.",["1/2","1","3/2","2","5/2"]) with{SourceProblem=Source};
        Assert.Equal("pass",AcidBaseMixtureCheck.InspectSource(stage)!.State);
    }

    [Fact] public void RejectsUnchangedSourceAsFullTwinProblem()
    {
        var copy=Result(Source,"② 3/4","a=2, b=1, x=3/4이다.") with{SourceProblem=Source};
        Assert.Equal("fail",AcidBaseMixtureCheck.InspectOriginality(copy)!.State);
    }
}
