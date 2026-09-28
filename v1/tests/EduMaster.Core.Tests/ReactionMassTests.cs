using EduMaster.Core;
namespace EduMaster.Core.Tests;
public class ReactionMassTests
{
    [Fact]public void WholeGramRowsAreCheckedWithoutInventingAUnitSymbol()
    {
        var body="""
        다음은 A(g)와 B(g)가 반응하여 C(g)와 D(g)를 생성하는 반응의 화학 반응식이다.
        A(g) + bB(g) → 2C(g) + 2D(g) (b는 반응 계수)
        반응 전 질량과 반응 후 잔류 질량, D의 양/전체 기체의 양 (상댓값)은 아래 표와 같다.
        | 실험 | 반응 전 A 질량(g) | 반응 전 B 질량(g) | 반응 후 잔류 질량(g) | D의 양/전체 기체의 양 (상댓값) |
        | :---: | :---: | :---: | :---: | :---: |
        | Ⅰ | 6 | 3 | 5 | x |
        | Ⅱ | 2 | 10 | 4 | 15 |
        | Ⅲ | 6 | 9 | 3 | 18 |
        b/x × (C의 몰질량 + D의 몰질량)/B의 몰질량 은?
        """;
        var solved=ReactionMassCheck.Solve(body)!;
        Assert.Equal(3,solved.B);Assert.Equal(10,solved.X);Assert.Equal("3/5",solved.Answer);
        Assert.Equal("pass",ReactionMassCheck.InspectMassConditions(body)!.State);
    }
    private const string Source="""
        A(g) + bB(g) → 2C(g) + 2D(g)
        D의 양(mol)/전체 기체의 양(mol) (상댓값)
        | I | 5w | 5w | A (10/3)w | x |
        | II | 4w | 6w | A 2w | 18 |
        | III | 2w | 7w | B w | 20 |
        각 기체의 몰 질량(g/mol)을 M_A,M_B,M_C,M_D라 할 때 (b/x) × (M_C+M_D)/M_B는?
        """;
    [Fact]public void InlineHandwritingAnnotationIsNotATableNumber(){
        var annotated=Source.Replace("| x |","| x [주석: x=15는 필기] |");
        Assert.Equal("2/5",ReactionMassCheck.Solve(annotated)!.Answer);
        var variant=ReactionMassCheck.UniformMassVariantBody(annotated);
        ReactionMassCheck.VerifyUniformMassScale(annotated,variant);
        Assert.Contains("| x |",variant);Assert.DoesNotContain("x=15",variant);
    }
    [Fact]public void PrintedInvalidTableValueStillRejected(){
        Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.Solve(Source.Replace("| 18 |","| 18잘못읽음 |")));
    }
    [Fact] public void ReferenceRelativeFractionsSolveToTwoFifths(){var s=ReactionMassCheck.Solve(Source)!;Assert.Equal(3,s.B);Assert.Equal(15,s.X,7);Assert.Equal("2/5",s.Answer);}
    [Fact] public void IntegratedVariantParenthesizesFractionalMasses()
    {
        var body=ReactionMassCheck.IntegratedMassVariantBody(Source,[0,0,1])!;
        Assert.Contains("B (7/2)w",body);
        Assert.Contains("(49/2)w",body);
        Assert.Equal(30,ReactionMassCheck.Solve(body)!.X);
    }
    [Fact]public void ExperimentLabelFormattingDoesNotChangeTheAnswer(){
        var body=Source.Replace("| I |","| **실험 Ⅰ** |").Replace("| II |","| $Ⅱ$ |").Replace("| III |","| Ⅲ |");
        Assert.Equal("2/5",ReactionMassCheck.Solve(body)!.Answer);
    }
    [Fact]public void SeparateResidualSpeciesColumnCanBeReadWithoutChangingValues(){
        var body=Source.Replace("| A (10/3)w |","| A | (10/3)w |").Replace("| A 2w |","| A | 2w |").Replace("| B w |","| B | w |");
        Assert.Equal("2/5",ReactionMassCheck.Solve(body)!.Answer);
    }
    [Fact]public void EmptyOrDuplicateRowsCannotBeSilentlyCollapsed(){
        Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.Solve(Source.Replace("| 5w | 5w |","| 5w | | 5w |")));
        Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.Solve(Source.Replace("| II |","| I |")));
    }
    [Fact]public void AdditionalMoleColumnsDoNotBreakIndependentMassCheck(){
        var body="반응 전 반응 후 질량\n"+Source.Replace("| x |","| 6 | 16 |").Replace("| 18 |","| 8 | 18 |").Replace("| 20 |","| 8 | 20 |");
        Assert.Equal("pass",ReactionMassCheck.InspectMassConditions(body)!.State);
        Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.Solve(body));
    }
    [Fact]public async Task InvalidGeneratedTableReturnsQualityFailureForRewriteInsteadOfThrowing(){
        var draft=new ProblemDraft{Title="반응량",Body=Source,Answer="② 2/5",Explanation="해설",Steps=["질량 비교","몰수 계산","상대값 계산"],UseSolutionLogic=true};
        var body=Source.Replace("| x |","| 6 | 16 |").Replace("| 18 |","| 8 | 18 |").Replace("| 20 |","| 8 | 20 |");
        var r=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"변형",body,["1/5","2/5","3/5","4/5","1"],"② 2/5","해설",draft.Steps,"변형");
        using var client=new HttpClient();
        var checkedResult=await new QualityReviewClient(client).ReviewTextAsync(r,draft,"deepseek","http://127.0.0.1:1","unused","");
        Assert.Equal("fail",checkedResult.Quality!.State);
        Assert.Contains(checkedResult.Quality.Checks,c=>c.Id=="calculation"&&c.State=="fail"&&c.Evidence.Contains("6열"));
        Assert.Equal(r.Answer,checkedResult.Answer);
    }
    [Fact]public void MassConditionsPassConsistentRowsAndRejectChangedRatioRegardlessOfQuestion(){var text="반응 전 A의 질량 · 반응 후 A 또는 B의 질량\n"+Source.Replace("몰 질량","물질량");Assert.Null(ReactionMassCheck.Solve(text));Assert.Equal("pass",ReactionMassCheck.InspectMassConditions(text)!.State);Assert.Equal("fail",ReactionMassCheck.InspectMassConditions(text.Replace("| II | 4w | 6w", "| II | 4w | 8w"))!.State);Assert.Null(ReactionMassCheck.InspectMassConditions("NaOH 가열 농도"));}
    [Fact] public void UniformMassScalePreservesDimensionlessAnswer(){var doubled=Source.Replace("| I | 5w | 5w | A (10/3)w | x |","| I | 10w | 10w | A (20/3)w | x |").Replace("| II | 4w | 6w | A 2w | 18 |","| II | 8w | 12w | A 4w | 18 |").Replace("| III | 2w | 7w | B w | 20 |","| III | 4w | 14w | B 2w | 20 |");Assert.Equal("2/5",ReactionMassCheck.Solve(doubled)!.Answer);}
    [Fact]public void TwinLogicAllowsUniformNumberChangesButRejectsChangedResidualPattern(){var doubled=ReactionMassCheck.UniformMassVariantBody(Source,2,true);ReactionMassCheck.VerifySameLogicVariant(Source,doubled);Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.VerifySameLogicVariant(Source,doubled.Replace("4w","5w")));}
    [Fact]public void PartialStageSafelyHidesExposedRemainingSpeciesAndRebuildsProof(){
        const string exposed="""
A(g) + 3B(g) → 2C(g) + 2D(g)
| 실험 | 반응 전 A의 질량(g) | 반응 전 B의 질량(g) | 반응 후 남은 기체의 질량(g) |
| Ⅰ | 5w | 6w | A 3w |
| Ⅱ | 5w | 9w | A 2w |
| Ⅲ | 4w | 16w | B 4w |
한계 반응물과 남는 기체를 추론한 것은?
""";
        Assert.True(ReactionMassCheck.TryHideRemainingSpecies(exposed,out var hidden,out var proof));Assert.DoesNotContain("| A 3w |",hidden);Assert.DoesNotContain("| B 4w |",hidden);Assert.Contains("남는 기체는 A, A, B",proof);Assert.Contains("소비 질량비는 3",proof);
        var draft=new ProblemDraft{Title="STEP 1",Body=Source,Explanation="풀이",Steps=["한계 반응물 가정과 여러 실험의 모순 비교"],UseSolutionLogic=true,SkipDeterministicPlan=true,IsPartialLearningStage=true};
        var seed=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"연습",exposed,["1","2","3","4","5"],"① 1","직접 읽기",["표의 A/B를 읽는다"],"변형");var repaired=LearningStagePlan.RepairExposedConclusion(seed,draft);
        Assert.Equal(hidden,repaired.Body);Assert.Equal(proof,repaired.Steps[0]);Assert.Contains("직접 읽기",repaired.Explanation);Assert.Contains(proof,repaired.Explanation);Assert.Contains("유일성을 코드 검산",repaired.ChangeSummary);
    }
    [Fact] public void DifferentRelativeFractionChangesCoefficientAndAnswer(){var s=ReactionMassCheck.Solve(Source.Replace("B w | 20","B w | 18"))!;Assert.Equal(6,s.B);Assert.Equal("8/5",s.Answer);}
    [Fact] public void ContradictoryConsumptionRatiosRejected()=>Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.Solve(Source.Replace("6w","8w")));
    [Fact] public void NonIntegralCoefficientRejected()=>Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.Solve(Source.Replace("B w | 20","B w | 16")));
    [Fact] public void QuantityMisreadingIsNotSilentlyChanged()=>Assert.Null(ReactionMassCheck.Solve(Source.Replace("몰 질량","물질량")));
    [Fact] public void MisreadQuantityNeedsReviewBeforeGeneration()=>Assert.True(ReactionMassCheck.NeedsQuantityReview(Source.Replace("몰 질량","물질량")));
    [Fact] public void CalculatedVariantKeepsRatiosAndHidesAnnotatedAnswer()
    {
        var annotated=Source.Replace("| x |","| x=15 |");var body=ReactionMassCheck.UniformMassVariantBody(annotated);
        ReactionMassCheck.VerifyUniformMassScale(annotated,body);Assert.Equal("2/5",ReactionMassCheck.Solve(body)!.Answer);
        Assert.Contains("(20/3)w",body);Assert.Contains("| 18 |",body);Assert.Contains("| 20 |",body);Assert.DoesNotContain("x=15",body);
        Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.VerifyUniformMassScale(annotated,body.Replace("| x |","| x=15 |")));
    }
    [Fact] public void IncorrectAnnotationRejected()=>Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.Solve(Source.Replace("| x |","| x=14 |")));
    [Fact] public void DifferentRequestedRatioIsOutsideNarrowCheck()=>Assert.Null(ReactionMassCheck.Solve(Source.Replace("(b/x)","(x/b)")));
    [Fact] public void RelativeRatiosCannotBeScaledLikeMasses()
    {
        var doubled=Source.Replace("| I | 5w | 5w | A (10/3)w | x |","| I | 10w | 10w | A (20/3)w | x |").Replace("| II | 4w | 6w | A 2w | 18 |","| II | 8w | 12w | A 4w | 18 |").Replace("| III | 2w | 7w | B w | 20 |","| III | 4w | 14w | B 2w | 20 |");
        ReactionMassCheck.VerifyUniformMassScale(Source,doubled);
        Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.VerifyUniformMassScale(Source,doubled.Replace("| 18 |","| 36 |").Replace("| 20 |","| 40 |")));
        Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.VerifyUniformMassScale(Source,doubled.Replace("10w","15w")));
    }
}
