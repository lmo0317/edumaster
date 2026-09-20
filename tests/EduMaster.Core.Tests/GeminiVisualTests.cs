using System.Net;
using System.Text.Json;
using EduMaster.Core;
namespace EduMaster.Core.Tests;

public class GeminiVisualTests
{
    private static ProblemDraft Draft()=>new(){Title="탄산칼슘",Body="탄산칼슘 10 g을 분해한다. 몰질량 100 g/mol. CO₂ 양은?"};
    private static byte[] Response(ProblemDraft draft,string finish="STOP",string? fingerprint=null)=>JsonSerializer.SerializeToUtf8Bytes(new{
        candidates=new[]{new{finishReason=finish,content=new{parts=new[]{new{text=JsonSerializer.Serialize(new{status="ready",message="",inputFingerprint=fingerprint??draft.Fingerprint(),sourceLocation="기준 자료",title="새 문제",body="탄산칼슘 20 g을 분해한다. CO₂ 양은?",choices=new[]{"0.1 mol","0.2 mol","0.3 mol","0.4 mol","0.5 mol"},answerText="0.2 mol",explanation="20/100=0.2 mol",steps=new[]{"몰질량","몰수","계수비"},changeSummary="10g→20g"})}}}}},usageMetadata=new{totalTokenCount=123}});
    [Fact]public void KeepsInputFingerprintAndCloudUsage(){var d=Draft();var r=GeminiVisualGenerator.ParseResponse(Response(d),d);Assert.Equal(d.Fingerprint(),r.InputFingerprint);Assert.Equal("② 0.2 mol",r.Answer);Assert.Contains("123",r.UsageSummary);Assert.DoesNotContain("로컬 실행",r.UsageSummary);}
    [Fact]public void RejectsAnotherInputsResponse(){var d=Draft();Assert.Throws<InvalidDataException>(()=>GeminiVisualGenerator.ParseResponse(Response(d,fingerprint:"wrong"),d));}
    [Fact]public void RejectsTruncatedResponse(){var d=Draft();Assert.Throws<InvalidDataException>(()=>GeminiVisualGenerator.ParseResponse(Response(d,"MAX_TOKENS"),d));}
    private sealed class Handler(int transientFailures=0):HttpMessageHandler{
        public int Calls;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token){
            if(++Calls<=transientFailures)return new(HttpStatusCode.ServiceUnavailable);
            Assert.Equal("test-key",request.Headers.GetValues("x-goog-api-key").Single());Assert.Equal("",request.RequestUri!.Query);
            using var json=JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));var parts=json.RootElement.GetProperty("contents")[0].GetProperty("parts");
            Assert.Equal("AQID",parts[1].GetProperty("inlineData").GetProperty("data").GetString());
            using var source=JsonDocument.Parse(parts[0].GetProperty("text").GetString()!);
            return new(HttpStatusCode.OK){Content=new ByteArrayContent(Response(Draft(),fingerprint:source.RootElement.GetProperty("inputFingerprint").GetString()))};
        }
    }
    [Fact]public async Task SendsOriginalImageAndKeyOnlyInHeader(){using var client=new HttpClient(new Handler());var result=await new GeminiVisualGenerator(client).GenerateAsync(Draft(),"test-key",images:[new([1,2,3],"image/png",1)]);Assert.Equal(1,result.ImageInputCount);Assert.Single(result.Figures);}
    [Fact]public async Task RecoversFromTransientServiceFailure(){var handler=new Handler(1);using var client=new HttpClient(handler);var result=await new GeminiVisualGenerator(client).GenerateAsync(Draft(),"test-key",images:[new([1,2,3],"image/png",1)]);Assert.Equal(2,handler.Calls);Assert.Equal("② 0.2 mol",result.Answer);}
}
