using EduMaster.Core;
namespace EduMaster.Core.Tests;
public class ReactionMassTests
{
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
    [Fact]public void MassConditionsPassConsistentRowsAndRejectChangedRatioRegardlessOfQuestion(){var text="반응 전 A의 질량 · 반응 후 A 또는 B의 질량\n"+Source.Replace("몰 질량","물질량");Assert.Null(ReactionMassCheck.Solve(text));Assert.Equal("pass",ReactionMassCheck.InspectMassConditions(text)!.State);Assert.Equal("fail",ReactionMassCheck.InspectMassConditions(text.Replace("| II | 4w | 6w", "| II | 4w | 8w"))!.State);Assert.Null(ReactionMassCheck.InspectMassConditions("NaOH 가열 농도"));}
    [Fact] public void UniformMassScalePreservesDimensionlessAnswer(){var doubled=Source.Replace("| I | 5w | 5w | A (10/3)w | x |","| I | 10w | 10w | A (20/3)w | x |").Replace("| II | 4w | 6w | A 2w | 18 |","| II | 8w | 12w | A 4w | 18 |").Replace("| III | 2w | 7w | B w | 20 |","| III | 4w | 14w | B 2w | 20 |");Assert.Equal("2/5",ReactionMassCheck.Solve(doubled)!.Answer);}
    [Fact]public void TwinLogicAllowsUniformNumberChangesButRejectsChangedResidualPattern(){var doubled=ReactionMassCheck.UniformMassVariantBody(Source,2,true);ReactionMassCheck.VerifySameLogicVariant(Source,doubled);Assert.Throws<InvalidDataException>(()=>ReactionMassCheck.VerifySameLogicVariant(Source,doubled.Replace("(4)w","(5)w")));}
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
