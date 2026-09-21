using EduMaster.Core;

namespace EduMaster.Core.Tests;

public class GasMixtureAtomCheckTests
{
    private const string OriginalSource="""
(나)에서 X의 질량/Y의 질량 = 15/16이다.
| 용기 | 기체 | 기체의 질량(g) | X 원자 수/Z 원자 수 | 단위 질량당 Y 원자 수(상댓값) |
|---|---|---|---|---|
| (가) | XY₂, YZ₄ | 55w | 3/16 | 23 |
| (나) | XY₂, X₂Z₄ | 23w | 5/8 | 11 |
ㄱ. (가)에서 X의 질량/Y의 질량 = 1/2이다.
ㄴ. (나)에 들어 있는 전체 분자 수/(가)에 들어 있는 전체 분자 수 = 3/7이다.
ㄷ. X의 원자량/(Y의 원자량 + Z의 원자량) = 4/17이다.
""";
    private const string Statements="""
ㄱ. (가)에서 X의 질량/Y의 질량 = 1/2이다.
ㄴ. (나)에 들어 있는 전체 분자 수/(가)에 들어 있는 전체 분자 수 = 3/4이다.
ㄷ. X의 원자량/(Y의 원자량 + Z의 원자량) = 1/4이다.
""";
    private static SampleResult Result(string body,string explanation,string answer="③ ㄷ")=>new(Guid.NewGuid(),Guid.NewGuid(),"fixture","기체 혼합물",body,["ㄱ","ㄴ","ㄷ","ㄱ, ㄴ","ㄴ, ㄷ"],answer,explanation,["비율 계산"],"변형");
    private static string Body(int gaMass,int naMass,int gaUnit,int naUnit)=>$"""
(나)에서 X의 질량/Y의 질량 = 5/4이다.
| 용기 | 기체 | 기체의 질량(g) | X 원자 수/Z 원자 수 | 단위 질량당 Y 원자 수(상댓값) |
|---|---|---|---|---|
| (가) | XY2, YZ4 | {gaMass}w | 1/4 | {gaUnit} |
| (나) | XY2, X2Z4 | {naMass}w | 5/8 | {naUnit} |
{Statements}
""";
    [Fact]public void RejectsNegativeAtomicMassCausedByCountingYZ4AsFourYAtoms()
    {
        var result=Result(Body(47,71,213,47),"47w와 71w를 이용한다.","⑤ ㄴ, ㄷ");
        var check=GasMixtureAtomCheck.Inspect(result)!;
        Assert.Equal("fail",check.State);Assert.Contains("양의 원자량",check.Evidence);
    }
    [Fact]public void RejectsMissingTotalMassProofForCrossContainerMoleculeRatio()
    {
        var result=Result(Body(18,30,10,4),"(가)의 몰수를 c, (나)의 몰수를 a라 놓고 분자 수 비를 3a/2a로 둔다.");
        var check=GasMixtureAtomCheck.Inspect(result)!;
        Assert.Equal("fail",check.State);Assert.Contains("18w와 30w",check.Evidence);
    }
    [Fact]public void AcceptsIndependentlyConsistentMixtureAndMassProof()
    {
        var result=Result(Body(18,30,10,4),"(가) 18w=15cx, (나) 30w=25ax이다. 따라서 c=a이고 ㄷ만 참이다.");
        Assert.Equal("pass",GasMixtureAtomCheck.Inspect(result)!.State);
    }
    [Fact]public void CorrectsMisreadIntermediateValueBeforeGeneration()
    {
        var material=new ProblemSolutionMaterial(OriginalSource,"⑤ ㄴ, ㄷ","x:y=3:8이고 z=17k/4이다.",["비율 계산","z 계산","정답"],[]);
        var corrected=material.WithVerifiedLogic();
        Assert.Equal(3,corrected.Steps.Length);
        Assert.Contains("z=(19/4)k",corrected.Explanation);
        Assert.DoesNotContain("17k/4",corrected.Explanation);
        Assert.Contains("55w:23w",corrected.Explanation);
    }
    [Fact]public void RejectsSourceAnswerThatDisagreesWithPrintedTable()
    {
        var material=new ProblemSolutionMaterial(OriginalSource,"④ ㄱ, ㄴ","틀린 해설",["첫 단계","둘째 단계","셋째 단계"],[]);
        Assert.Throws<InvalidDataException>(()=>material.WithVerifiedLogic());
    }
}
