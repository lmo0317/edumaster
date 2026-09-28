using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using EduMaster.Core;

namespace EduMaster.Core.Tests;

public class StageQuestionRegressionTests
{
    static SampleResult FailedStage()
    {
        var v=JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","cf8e-stage2.json")))!;
        string S(string k)=>v[k]!.GetValue<string>();
        string[] A(string k)=>v[k]!.AsArray().Select(x=>x!.GetValue<string>()).ToArray();
        return new(Guid.NewGuid(),Guid.NewGuid(),"","실제 실패 초안",S("body"),A("choices"),S("answer"),S("explanation"),A("steps"),""){
            SourceProblem=S("sourceProblem"),SourceExplanation=S("sourceExplanation"),SourceSteps=A("sourceSteps")};
    }

    [Fact] public void ActualCf8eDraftCannotReachPaidReviewOrBeCalledPassed()
    {
        var failed=FailedStage();
        Assert.Equal("fail",LearningStagePlan.InspectQuestionScope(failed,true)!.State);
        Assert.Equal("fail",ExplanationConsistencyCheck.Inspect(failed)!.State);
        Assert.Contains("같은 보기 ㄱ",ExplanationConsistencyCheck.Inspect(failed)!.Evidence);
    }

    [Fact] public void PartialContextRemovesOriginalFinalQuestionButKeepsRawConditions()
    {
        var failed=FailedStage();
        var context=LearningStagePlan.ReferenceConditions(new(){Body=failed.SourceProblem,IsPartialLearningStage=true});
        Assert.Contains("신경 |",context);Assert.Contains("[그래프]",context);
        Assert.DoesNotContain("[보기]",context);Assert.DoesNotContain("t₁은 5ms",context);
        Assert.Equal(failed.SourceProblem,LearningStagePlan.ReferenceConditions(new(){Body=failed.SourceProblem}));
    }

    [Fact] public void QuotedFalseStatementIsNotMistakenForAProof()
    {
        var failed=FailedStage() with{Body="ㄱ. d₃는 Ⅲ이다.",Explanation="ㄱ. d₃는 Ⅲ이다. (×)\n실제 d₃는 Ⅳ이다. ㄱ은 옳지 않다."};
        Assert.NotEqual("fail",ExplanationConsistencyCheck.Inspect(failed,compareAnswer:false)?.State);
    }

    [Fact] public async Task PartialQuestionIsRewrittenBeforeSemanticReviewAndUsesSingleTarget()
    {
        var draft=new ProblemDraft{Title="거리와 속도",Body="거리 4 cm, 시간 2 ms.\n이에 대한 설명으로 옳은 것만을 고르시오.\n[보기]\nㄱ. 속도는 2 cm/ms이다.",
            UseSolutionLogic=true,Explanation="STEP 1. 거리를 확인한다.\nSTEP 2. 거리/시간으로 속도를 구한다.",
            Steps=["거리를 확인한다.","거리/시간으로 속도를 구한다."],IsPartialLearningStage=true};
        var calls=0;
        using var client=new HttpClient(new Handler(async request=>{
            calls++;
            var payload=JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;
            var source=JsonNode.Parse(payload["messages"]![1]!["content"]!.GetValue<string>())!;
            Assert.DoesNotContain("[보기]",source["body"]!.GetValue<string>());
            Assert.Null(source["teacherMethod"]!["referenceExplanation"]);
            var value=new JsonObject{["status"]="ready",["message"]="",["inputFingerprint"]=draft.Fingerprint(),["title"]="속도 연습",
                ["body"]="거리 6 cm, 시간 3 ms일 때 속도는?",["choices"]=new JsonArray("1 cm/ms","2 cm/ms","3 cm/ms","4 cm/ms","5 cm/ms"),
                ["answerText"]="2 cm/ms",["explanation"]="STEP 1. 거리는 6 cm이다.\nSTEP 2. 6/3=2 cm/ms이다.",
                ["steps"]=new JsonArray("거리 확인","속도 계산"),["sourceLocation"]="원본",["changeSummary"]="거리와 시간 변경",["visualRequirement"]="none"};
            if(calls==1){value["body"]="ㄱ. 속도는 2 cm/ms이다.\nㄴ. 시간은 3 ms이다.";value["choices"]=new JsonArray("ㄱ","ㄴ","ㄱ, ㄴ","ㄷ","ㄱ, ㄴ, ㄷ");value["answerText"]="ㄱ";}
            return Envelope(value);
        }));
        var result=await new DeepSeekVisualGenerator(client).GenerateAsync(draft,"test-only");
        Assert.Equal(2,calls);Assert.Null(LearningStagePlan.InspectQuestionScope(result,true));Assert.Equal("② 2 cm/ms",result.Answer);
    }

    [Fact] public async Task FailedPartialReviewDoesNotSpendASecondCallToOverruleIt()
    {
        var draft=new ProblemDraft{Title="덧셈",Body="2+3은?",UseSolutionLogic=true,Explanation="더한다.",Steps=["덧셈"],IsPartialLearningStage=true};
        var result=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),"덧셈","2+3은?",["1","2","3","4","5"],"⑤ 5","더하면 5다.",["덧셈"],"");
        var calls=0;
        using var client=new HttpClient(new Handler(_=>{
            calls++;
            return Task.FromResult(Envelope(new JsonObject{["checks"]=new JsonArray(new[]{"language","conditions","semantic-math","visual-semantics"}
                .Select(id=>(JsonNode)new JsonObject{["id"]=id,["state"]=id=="conditions"?"fail":"pass",["evidence"]="검토 근거"}).ToArray())}));
        }));
        var reviewed=await new QualityReviewClient(client).ReviewTextAsync(result,draft,"deepseek","https://api.deepseek.com","test","test-only");
        Assert.Equal(1,calls);Assert.Equal("fail",reviewed.Quality!.State);
    }

    static HttpResponseMessage Envelope(JsonObject v)=>new(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(new{choices=new[]{new{finish_reason="stop",message=new{content=v.ToJsonString()}}}}))};
    sealed class Handler(Func<HttpRequestMessage,Task<HttpResponseMessage>> send):HttpMessageHandler{
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>send(request);
    }
}
