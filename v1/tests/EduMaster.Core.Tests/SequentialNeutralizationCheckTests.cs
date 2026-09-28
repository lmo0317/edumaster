using EduMaster.Core;

namespace EduMaster.Core.Tests;

public class SequentialNeutralizationCheckTests
{
    private const string Source="""
20. 다음은 중화 반응에 대한 실험이다.
○ 수용액에서 AOH는 A⁺과 OH⁻으로, H₂B는 H⁺과 B²⁻으로, HC는 H⁺과 C⁻으로 모두 이온화된다.
(가) a M AOH(aq) 20 mL에 b M H₂B(aq) 5 mL를 첨가하여 혼합 용액 I을 만든다.
(나) I에 c M HC(aq) V mL를 첨가하여 혼합 용액 II를 만든다.
(다) II에 c M HC(aq) 10 mL를 첨가하여 혼합 용액 III을 만든다.
| 혼합 용액 | II | III |
| 음이온의 양(mol)/(양이온의 양(mol)) | (2)/(3) | (4)/(5) |
○ 모든 음이온의 몰 농도(M)의 합은 I과 II가 같다.
(c)/(a + b) × V는?
① 3 ② 5 ③ 6 ④ 12 ⑤ 15
""";

    [Fact] public void SolvesIncrementalThirdAcidAdditionAndVerifiesSource()
    {
        var solved=SequentialNeutralizationCheck.SolveSource(Source)!;
        Assert.Equal("① 3",solved.Answer);
        Assert.Equal(3,solved.Steps.Length);
        Assert.Contains("V=5",solved.Explanation);
        Assert.Contains("a=2/3",solved.Explanation);
        var result=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"source","중화",Source,["3","5","6","12","15"],solved.Answer,solved.Explanation,solved.Steps,"검사")
            {SourceProblem=Source,SourceAnswer=solved.Answer,SourceExplanation=solved.Explanation};
        Assert.Equal("pass",SequentialNeutralizationCheck.InspectSource(result)!.State);
        Assert.Equal("pass",SequentialNeutralizationCheck.Inspect(result)!.State);
    }

    [Fact] public void RejectsWrongAnswerAndAlteredThirdMixture()
    {
        var result=new SampleResult(Guid.NewGuid(),Guid.NewGuid(),"source","중화",Source,["3","5","6","12","15"],"② 5","틀린 해설",["계산"],"검사")
            {SourceProblem=Source,SourceAnswer="② 5"};
        Assert.Equal("fail",SequentialNeutralizationCheck.InspectSource(result)!.State);
        Assert.Equal("fail",SequentialNeutralizationCheck.Inspect(result)!.State);
        Assert.Throws<InvalidDataException>(()=>SequentialNeutralizationCheck.SolveSource(Source.Replace("II에 c M HC(aq) 10 mL","I에 c M HC(aq) 10 mL")));
    }

    [Fact] public void BuildsThreeIndependentlyCheckedLearningProblems()
    {
        var solved=SequentialNeutralizationCheck.SolveSource(Source)!;
        var draft=new ProblemDraft{Title="순차 중화 반응",Body=Source,Answer=solved.Answer,Explanation=solved.Explanation,Steps=solved.Steps,UseSolutionLogic=true};
        var planned=LearningStagePlan.Build(draft);
        var outputs=planned.Select(stage=>SequentialNeutralizationCheck.CreateLearningStage(stage.Draft,stage.Number,stage.Total)!).ToArray();
        Assert.Equal([1,2,3],outputs.Select(output=>output.Steps.Length));
        Assert.All(outputs,output=>Assert.True(output.Quality!.AnswerVerified));
        Assert.Equal("① II에서 H⁺가 남는다",outputs[0].Answer);
        Assert.Equal("③ 10",outputs[1].Answer);
        Assert.Equal("③ 10",outputs[2].Answer);
        Assert.NotEqual(Source,outputs[2].Body);
        var stageTwoAsSource=outputs[1].Body+"\n"+string.Join(" ",outputs[1].Choices.Select((choice,index)=>$"{"①②③④⑤"[index]} {choice}"));
        var solvedStageTwo=SequentialNeutralizationCheck.SolveSource(stageTwoAsSource)!;
        Assert.Equal("③ 10",solvedStageTwo.Answer);
        Assert.Equal(2,solvedStageTwo.Steps.Length);
    }
}
