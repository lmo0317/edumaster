using EduMaster.Core;
using System.Net;

namespace EduMaster.Core.Tests;

public class DeepSeekAccountTests
{
    [Fact]public async Task EmptyBalanceStopsBeforeAnyPaidCall()
    {
        var calls=0;
        using var client=new HttpClient(new Handler(request=>{
            calls++;Assert.Equal(HttpMethod.Get,request.Method);Assert.Equal("/user/balance",request.RequestUri!.AbsolutePath);
            return new(HttpStatusCode.OK){Content=new StringContent("{\"is_available\":false,\"balance_infos\":[]}")};
        }));
        var error=await Assert.ThrowsAsync<DeepSeekAccountException>(()=>new DeepSeekAccountClient(client).EnsureAvailableAsync("test-only"));
        Assert.Equal(1,calls);Assert.Contains("입력은 유지",error.Message);
    }
    [Fact]public async Task AvailableBalanceAllowsWorkAndMalformedStatusDoesNot()
    {
        using var good=new HttpClient(new Handler(_=>new(HttpStatusCode.OK){Content=new StringContent("{\"is_available\":true}")}));
        await new DeepSeekAccountClient(good).EnsureAvailableAsync("test-only");
        using var bad=new HttpClient(new Handler(_=>new(HttpStatusCode.OK){Content=new StringContent("{\"unexpected\":true}")}));
        await Assert.ThrowsAsync<InvalidOperationException>(()=>new DeepSeekAccountClient(bad).EnsureAvailableAsync("test-only"));
    }
    [Fact]public async Task GenerationPaymentFailureNeverTriggersFormatOrVisualRetries()
    {
        var calls=0;
        using var client=new HttpClient(new Handler(_=>{calls++;return new(HttpStatusCode.PaymentRequired){Content=new StringContent("{}")} ;}));
        await Assert.ThrowsAsync<DeepSeekAccountException>(()=>new DeepSeekVisualGenerator(client).GenerateAsync(new ProblemDraft{Title="검증",Body="두 수 2와 3의 합을 구하시오."},"test-only"));
        Assert.Equal(1,calls);
    }
    private sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> handler):HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)=>Task.FromResult(handler(request));
    }
}
