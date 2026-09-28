using System.Net;
using System.Text.Json;
using EduMaster.Core;
namespace EduMaster.Core.Tests;

public class VisualPipelineTests
{
    private static object Context(string[]? uncertainties=null,string from="x")=>new{kind="graph",summary="직선 그래프",nodes=new[]{new{id="x",label="x축"},new{id="line",label="y=2x"}},edges=new[]{new{from,to="line",relation="독립 변수"}},constraints=new[]{"원점을 지난다","x=2일 때 y=4"},uncertainties=uncertainties??[]};
    [Fact]public void MissingEdgeEndpointRejected()=>Assert.Throws<InvalidDataException>(()=>VisualUnderstanding.Parse(JsonSerializer.Serialize(Context(from:"missing"))));
    [Fact]public void UncertainImageRejected()=>Assert.Throws<InvalidDataException>(()=>VisualUnderstanding.Parse(JsonSerializer.Serialize(Context(["축 눈금 판독불가"]))));
    [Fact]public void NonConflictingObservationAccepted(){var v=VisualUnderstanding.Parse(JsonSerializer.Serialize(new{kind="table",summary="표",nodes=Array.Empty<object>(),edges=Array.Empty<object>(),constraints=Array.Empty<string>(),uncertainties=new[]{"화학 반응식의 계수 b는 이미지에 '3'으로 표시되어 있으나, 본문에서 b는 변수로 표현되어 있음. 이는 이미지에서 직접적으로 확인할 수 있는 정보이므로 본문과의 충돌은 없음."}}));Assert.Equal("table",v.Kind);}
    [Fact]public void GraphCannotHaveEmptyRelations()=>Assert.Throws<InvalidDataException>(()=>VisualUnderstanding.Parse("""{"kind":"graph","summary":"그래프","nodes":[],"edges":[],"constraints":[],"uncertainties":[]}"""));
    [Theory][InlineData(false,false)][InlineData(true,true)]
    public void ContradictionOrUncertainVerificationRejected(bool consistent,bool uncertain)=>Assert.Throws<InvalidDataException>(()=>LocalVisionReader.ValidateVerification(JsonSerializer.Serialize(new{consistent,message="불일치",uncertainties=uncertain?new[]{"교점 확인 불가"}:Array.Empty<string>()})));
    [Fact]public void MalformedVerificationRejected()=>Assert.Throws<InvalidDataException>(()=>LocalVisionReader.ValidateVerification("{}"));
    [Fact]public async Task OriginalImageReachesBothVisualStagesAndResult()
    {
        var draft=new ProblemDraft{Title="직선",Body="그림은 y=2x이다. x=2일 때 y의 값은?"};
        var image=new VisualPage([1,2,3],"image/png",1);int visionCalls=0,gemmaCalls=0;
        using var http=new HttpClient(new Handler(async request=>{
            if(request.Method==HttpMethod.Get)return request.RequestUri!.AbsolutePath=="/props"?Json(new{modalities=new{vision=true}}):Json(new{data=new[]{new{id="gemma-4-12b"}}});
            using var body=JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            if(request.RequestUri!.Port==8091){
                visionCalls++;var content=body.RootElement.GetProperty("messages")[0].GetProperty("content");
                Assert.Equal(image.DataUrl,content[1].GetProperty("image_url").GetProperty("url").GetString());
                if(visionCalls==1)return Envelope(Context());
                Assert.Contains("x=3",content[0].GetProperty("text").GetString());return Envelope(new{consistent=true,message="그림 관계 유지",uncertainties=Array.Empty<string>()});
            }
            gemmaCalls++;var parts=body.RootElement.GetProperty("messages")[1].GetProperty("content");
            Assert.Equal(image.DataUrl,parts[1].GetProperty("image_url").GetProperty("url").GetString());
            var source=parts[0].GetProperty("text").GetString()!;
            Assert.Contains("독립 변수",source);Assert.Contains("visualContext",source);
            return Envelope(new{status="ready",message="",title="직선 변형",body="첨부한 기준 그림은 y=2x이다. x=3일 때 y의 값은?",choices=new[]{"2","3","4","5","6"},answerText="6",explanation="y=2×3=6",steps=new[]{"기울기 확인","x=3 대입","y=6 계산"},changeSummary="x=2 → 3",inputFingerprint=draft.Fingerprint(),sourceLocation="문항 1",graph=new{type="line",title="y=2x",xLabel="x",yLabel="y",xPoints=new[]{0.0,1.0,2.0,3.0},yPoints=new[]{0.0,2.0,4.0,6.0},annotations=Array.Empty<string>()}});
        }));
        var result=await new LocalGemmaGenerator(http).GenerateAsync(draft,LocalGemmaGenerator.DefaultEndpoint,images:[image]);
        Assert.NotNull(result.Graph);Assert.Equal(2,visionCalls);Assert.Equal(1,gemmaCalls);Assert.Equal(1,result.ImageInputCount);Assert.Equal(image.DataUrl,Assert.Single(result.Figures).DataUrl);Assert.Single(result.VisualContexts);Assert.Contains("대조",result.VisualVerification);
    }
    [Fact]public async Task UncertaintyStopsBeforeGemmaComposition()
    {
        int posts=0;using var http=new HttpClient(new Handler(request=>{
            if(request.Method==HttpMethod.Get)return Task.FromResult(request.RequestUri!.AbsolutePath=="/props"?Json(new{modalities=new{vision=true}}):Json(new{data=new[]{new{id="gemma-4-12b"}}}));
            posts++;Assert.Equal(8091,request.RequestUri!.Port);return Task.FromResult(Envelope(Context(["결합 판독 불가"])));
        }));
        await Assert.ThrowsAsync<InvalidDataException>(()=>new LocalGemmaGenerator(http).GenerateAsync(new(){Title="그림",Body="그림 문제이다."},LocalGemmaGenerator.DefaultEndpoint,images:[new([1],"image/png",1)]));Assert.Equal(1,posts);
    }
    [Fact]public async Task TextOnlyGemmaCannotAcceptAnImageProblem()
    {
        using var http=new HttpClient(new Handler(request=>{
            Assert.Equal(HttpMethod.Get,request.Method);
            return Task.FromResult(request.RequestUri!.AbsolutePath=="/props"?Json(new{modalities=new{vision=false}}):Json(new{data=new[]{new{id="gemma-4-12b"}}}));
        }));
        var error=await Assert.ThrowsAsync<InvalidOperationException>(()=>new LocalGemmaGenerator(http).GenerateAsync(new(){Title="그림",Body="그림 문제이다."},LocalGemmaGenerator.DefaultEndpoint,images:[new([1],"image/png",1)]));Assert.Contains("이미지 입력이 꺼져",error.Message);
    }
    private static HttpResponseMessage Json(object v)=>new(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(v))};
    private static HttpResponseMessage Envelope(object v)=>Json(new{choices=new[]{new{finish_reason="stop",message=new{content=JsonSerializer.Serialize(v)}}}});
    private sealed class Handler(Func<HttpRequestMessage,Task<HttpResponseMessage>> send):HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken t)=>send(r);}
}
