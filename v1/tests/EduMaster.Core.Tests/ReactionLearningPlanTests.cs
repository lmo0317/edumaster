using System.Text.Json.Nodes;
using EduMaster.Core;

namespace EduMaster.Core.Tests;
public class ReactionLearningPlanTests
{
    public static ProblemDraft FailedSource()
    {
        var v=JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","d2aa-stage1.json")))!;
        return new(){Title="실제 실패 반응량 입력",Body=v["sourceProblem"]!.GetValue<string>(),Answer=v["sourceAnswer"]!.GetValue<string>(),
            Explanation=v["sourceExplanation"]!.GetValue<string>(),Steps=v["sourceSteps"]!.AsArray().Select(x=>x!.GetValue<string>()).ToArray(),UseSolutionLogic=true};
    }
    [Fact]public void ActualFailedSourceCreatesAndPublishesAllThreeWithoutAmodel()
    {
        var source=FailedSource();
        var stages=LearningStagePlan.Build(source);
        var results=stages.Select(s=>ReactionLearningPlan.Create(s.Draft,s.Number,s.Total)).ToArray();
        Assert.All(results,r=>Assert.NotNull(r));
        Assert.Equal(new[]{1,2,3},results.Select(r=>r!.Steps.Length));
        foreach(var r in results){
            Assert.NotEqual("fail",r!.Quality!.State);
            Assert.True(r.Quality.AnswerVerified);
            Assert.Equal("pass",ReactionLearningPlan.Inspect(r)!.State);
            Assert.Contains("AI 호출 없음",r.UsageSummary);
        }
        Assert.False(ReactionMassCheck.SameResidualLayout(source.Body,results[2]!.Body));
        Assert.Contains("모순",results[0]!.Explanation);
        Assert.DoesNotContain("몰분율",results[1]!.Explanation);
        Assert.Contains("n mol",results[1]!.Explanation);Assert.Contains("m mol",results[1]!.Explanation);
        Assert.Contains("k =",results[2]!.Explanation);
    }
    [Fact]public void ChangedFirstRowOrAnswerIsRejectedByIndependentCheck()
    {
        var r=ReactionLearningPlan.Create(LearningStagePlan.Build(FailedSource())[0].Draft,1,3)!;
        Assert.Equal("fail",ReactionLearningPlan.Inspect(r with{Answer="① A"})!.State);
        var lines=r.Body.Split('\n');var row=Array.FindIndex(lines,l=>l.StartsWith("| Ⅱ |"));
        var cells=lines[row].Trim('|').Split('|');cells[3]=" 999w ";lines[row]="|"+string.Join("|",cells)+"|";
        Assert.Equal("fail",ReactionLearningPlan.Inspect(r with{Body=string.Join("\n",lines)})!.State);
    }
    [Fact]public void MultipleInputScalesProduceConsistentSetsAndPreserveTeacherSteps()
    {
        foreach(var scale in new[]{2,3,4,5}){
            var source=FailedSource();source=source with{Body=ReactionMassCheck.UniformMassVariantBody(source.Body,scale)};
            foreach(var stage in LearningStagePlan.Build(source)){
                var r=ReactionLearningPlan.Create(stage.Draft,stage.Number,stage.Total)!;
                Assert.Equal("pass",ReactionLearningPlan.Inspect(r)!.State);
                Assert.NotEqual("fail",r.Quality!.State);
            }
        }
    }
    [Fact]public void DifferentTeacherMethodAndUnknownSubjectsStayOnNormalModelPath()
    {
        var source=FailedSource();var stage=LearningStagePlan.Build(source)[0].Draft;
        Assert.Null(ReactionLearningPlan.Create(stage with{Steps=["표에 적힌 값만 대입한다."]},1,3));
        Assert.Null(ReactionLearningPlan.Create(stage with{Body="생명과학 신경 전도 속도"},1,3));
        Assert.Null(ReactionLearningPlan.Create(stage with{Explanation="A를 t mol이라 놓는다."},1,3));
    }
    [Fact]public void PartialProblemsRequireInferenceAndFullProblemUsesThatInference()
    {
        var stages=LearningStagePlan.Build(FailedSource());
        var first=ReactionLearningPlan.Create(stages[0].Draft,1,3)!;
        var second=ReactionLearningPlan.Create(stages[1].Draft,2,3)!;
        var full=ReactionLearningPlan.Create(stages[2].Draft,3,3)!;
        Assert.DoesNotContain("| Ⅲ |",first.Body);Assert.DoesNotContain("| Ⅲ |",second.Body);
        Assert.Contains("남은 반응물",second.Body);Assert.DoesNotContain("남은 B",second.Body);
        Assert.All(second.Choices,c=>Assert.EndsWith("m/n",c));Assert.Equal(5,second.Choices.Distinct().Count());
        Assert.Contains("m/n",full.Explanation);Assert.Contains("M_A/M_B",full.Explanation);
        Assert.Contains("STEP 2",full.Explanation);
        ReactionLearningPlan.VerifyEdited(full,full);
        Assert.Throws<InvalidDataException>(()=>ReactionLearningPlan.VerifyEdited(full,full with{Answer="① 999"}));
    }
}
