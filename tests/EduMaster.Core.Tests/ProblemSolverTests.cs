using System.Net;
using System.Text;
using System.Text.Json;
using EduMaster.Core;

namespace EduMaster.Core.Tests;

public class ProblemSolverTests
{
    [Fact]public async Task SupportedReactionCreatesThreeVerifiedStepsWithoutCallingAModel(){
        using var http=new HttpClient(new RejectCalls());
        var solved=await new ProblemSolver(http).SolveAsync("반응량",ReactionVariantPlanTests.Source,"deepseek",DeepSeekVisualGenerator.Model,"unused");
        Assert.Equal("2/5",solved.Answer);Assert.Equal(3,solved.Steps.Length);Assert.Contains("A, A, B",solved.Steps[0]);Assert.Equal("코드 독립 검산",solved.Method);
    }

    [Fact]public async Task GeneralProblemUsesSelectedModelAndRequiresThreeSteps(){
        using var http=new HttpClient(new ReplyHandler());
        var solved=await new ProblemSolver(http).SolveAsync("일차방정식","2x+3=7일 때 x는?","deepseek",DeepSeekVisualGenerator.Model,"test");
        Assert.Equal("2",solved.Answer);Assert.Equal(3,solved.Steps.Length);Assert.Contains("DeepSeek",solved.Method);
    }

    private sealed class RejectCalls:HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken)=>throw new Exception("model must not be called");}
    private sealed class ReplyHandler:HttpMessageHandler{
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken){
            using var payload=JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));Assert.Equal(DeepSeekVisualGenerator.Model,payload.RootElement.GetProperty("model").GetString());
            var answer=JsonSerializer.Serialize(new{status="ready",message="",answer="2",explanation="양변에서 3을 빼고 2로 나누면 x의 값을 구할 수 있으며 원식 대입으로 확인한다.",steps=new[]{"STEP 1 · 양변에서 3을 뺀다.","STEP 2 · 양변을 2로 나눈다.","STEP 3 · x=2를 원식에 대입해 검산한다."}});
            var outer=JsonSerializer.Serialize(new{choices=new[]{new{finish_reason="stop",message=new{content=answer}}}});
            return new(HttpStatusCode.OK){Content=new StringContent(outer,Encoding.UTF8,"application/json")};
        }
    }
}
