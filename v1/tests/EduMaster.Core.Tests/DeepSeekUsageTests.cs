using EduMaster.Core;
using EduMaster.Web;
using System.Net;
using System.Text.Json;

namespace EduMaster.Core.Tests;

public class DeepSeekUsageTests
{
    [Fact]public async Task OfflineGenerationVerificationCannotReachPaidTransport()
    {
        var directory=Temp();
        try{
            using var handler=new DeepSeekUsageHandler(directory,new Fake(_=>throw new Exception("Paid transport reached")),disablePaidCalls:true);
            using var client=new HttpClient(handler);using var scope=handler.BeginScope("offline-job","generation");
            using var request=PaidRequest();await Assert.ThrowsAsync<InvalidOperationException>(()=>client.SendAsync(request));
            Assert.Equal(0,handler.Summary("offline-job").Calls);
        }finally{Directory.Delete(directory,true);}
    }
    [Fact]public async Task TruncatedOutputIsAccountedBeforeModelParserRejectsIt()
    {
        var directory=Temp();
        try{
            using var handler=new DeepSeekUsageHandler(directory,new Fake(_=>new(HttpStatusCode.OK){Content=new StringContent("{\"choices\":[{\"finish_reason\":\"length\",\"message\":{\"content\":\"broken\"}}],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":30,\"total_tokens\":150}}") }));
            using var client=new HttpClient(handler);using var scope=handler.BeginScope("job-id","generate");
            using var request=PaidRequest();using var response=await client.SendAsync(request);
            Assert.Throws<InvalidDataException>(()=>DeepSeekVisualGenerator.ParseResponse(response.Content.ReadAsByteArrayAsync().Result,new ProblemDraft{Body="두 수 2와 3의 합을 구하시오."}));
            var usage=handler.Summary("job-id");Assert.Equal(150L,usage.TotalTokens);Assert.Equal(1,usage.Calls);Assert.Equal(0,usage.UnknownUsageCalls);
            var saved=File.ReadAllText(Directory.GetFiles(directory,"*.json").Single());Assert.DoesNotContain("secret-key",saved);Assert.DoesNotContain("private-question",saved);Assert.DoesNotContain("broken",saved);
        }finally{Directory.Delete(directory,true);}
    }
    [Fact]public async Task SharedScopeBlocksExcessCallsBeforeTransportAndPersistsAcrossNewHandler()
    {
        var directory=Temp();var calls=0;
        try{
            using(var handler=new DeepSeekUsageHandler(directory,new Fake(_=>{calls++;return new(HttpStatusCode.OK){Content=new StringContent("{\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}")};})))
            using(var client=new HttpClient(handler))using(var scope=handler.BeginScope("same-job","generate",2)){
                using(var stage=handler.BeginStage("stage-1")){using var request=PaidRequest();using var response=await client.SendAsync(request);}
                using(var stage=handler.BeginStage("stage-2")){using var request=PaidRequest();using var response=await client.SendAsync(request);}
                using var third=PaidRequest();await Assert.ThrowsAsync<DeepSeekCallLimitException>(()=>client.SendAsync(third));Assert.Equal(2,calls);
            }
            using var restored=new DeepSeekUsageHandler(directory,new Fake(_=>throw new Exception("Must not send")));
            var usage=restored.Summary("same-job");Assert.Equal(2,usage.Calls);Assert.Equal(24L,usage.TotalTokens);Assert.Equal(new[]{"stage-1","stage-2"},restored.Read().Select(r=>r.Operation));
        }finally{Directory.Delete(directory,true);}
    }
    [Fact]public async Task FailedNetworkCallHasUnknownUsageRatherThanZero()
    {
        var directory=Temp();
        try{
            using var handler=new DeepSeekUsageHandler(directory,new Fake(_=>throw new HttpRequestException("offline")));using var client=new HttpClient(handler);using var scope=handler.BeginScope("network-job","generate");
            using var request=PaidRequest();await Assert.ThrowsAsync<HttpRequestException>(()=>client.SendAsync(request));
            var row=Assert.Single(handler.Read());Assert.Null(row.TotalTokens);Assert.Equal(1,handler.Summary("network-job").UnknownUsageCalls);Assert.Equal(0,handler.Summary("network-job").PendingCalls);
        }finally{Directory.Delete(directory,true);}
    }
    [Fact]public async Task BalanceLookupIsNotCountedAsPaidModelRequest()
    {
        var directory=Temp();
        try{
            using var handler=new DeepSeekUsageHandler(directory,new Fake(_=>new(HttpStatusCode.OK){Content=new StringContent("{}") }));using var client=new HttpClient(handler);
            using var response=await client.GetAsync("https://api.deepseek.com/user/balance");Assert.Empty(handler.Read());
        }finally{Directory.Delete(directory,true);}
    }
    private static string Temp(){var path=Path.Combine(Path.GetTempPath(),"edumaster-usage-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(path);return path;}
    private static HttpRequestMessage PaidRequest(){var request=new HttpRequestMessage(HttpMethod.Post,"https://api.deepseek.com/chat/completions"){Content=new StringContent("private-question")};request.Headers.Authorization=new("Bearer","secret-key");return request;}
    private sealed class Fake(Func<HttpRequestMessage,HttpResponseMessage> send):HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>Task.FromResult(send(request));}
}
