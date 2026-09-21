using System.Net.Http.Json;
using System.Text.Json;
namespace EduMaster.Core;

public sealed record LocalModel(string Id, string Name, int ContextSize);
public sealed class LocalGemmaGenerator(HttpClient client)
{
    public const string DefaultEndpoint = "http://127.0.0.1:8092/v1/";
    public static string ConfiguredEndpoint => Environment.GetEnvironmentVariable("EDUMASTER_GEMMA_ENDPOINT")?.Trim() is {Length:>0} value?value:DefaultEndpoint;
    public static Uri Endpoint(string value)
    {
        if (!Uri.TryCreate(value,UriKind.Absolute,out var uri) || uri.Scheme != "http" || !uri.IsLoopback || uri.UserInfo!="" || uri.Query!="" || uri.Fragment!="" || uri.AbsolutePath.TrimEnd('/')!="/v1")
            throw new ArgumentException("현재 PC의 로컬 주소만 지원합니다. 예: http://127.0.0.1:8092/v1/");
        return new(uri.AbsoluteUri.TrimEnd('/')+"/");
    }
    public async Task<LocalModel> ProbeAsync(string endpoint,CancellationToken token=default,bool requireVision=false)
    {
        var uri=Endpoint(endpoint);
        using var response=await client.GetAsync(new Uri(uri,"models"),token);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("로컬 모델 목록을 읽지 못했습니다. AI 설정에서 서버 연결을 확인해 주세요.");
        using var json=JsonDocument.Parse(await FileImport.ReadLimitedAsync(await response.Content.ReadAsStreamAsync(token),1024*1024,token));
        var model=json.RootElement.GetProperty("data").EnumerateArray().FirstOrDefault(m =>
        { var id=m.GetProperty("id").GetString()??""; return id.Contains("gemma-4-12b",StringComparison.OrdinalIgnoreCase)||id.Contains("gemma4:12b",StringComparison.OrdinalIgnoreCase); });
        if (model.ValueKind==JsonValueKind.Undefined) throw new InvalidOperationException("이 서버에 Gemma 4 12B가 로드되지 않았습니다. 다른 모델로 자동 대체하지 않습니다.");
        var actual=model.GetProperty("id").GetString()!;
        var context=model.TryGetProperty("meta",out var meta)&&meta.TryGetProperty("n_ctx",out var nctx)?nctx.GetInt32():8192;
        if(requireVision){
            using var propsResponse=await client.GetAsync(new Uri(uri,"/props"),token);
            if(!propsResponse.IsSuccessStatusCode)throw new InvalidOperationException("Gemma 서버의 이미지 지원 여부를 확인하지 못했습니다.");
            using var props=JsonDocument.Parse(await FileImport.ReadLimitedAsync(await propsResponse.Content.ReadAsStreamAsync(token),1024*1024,token));
            if(!props.RootElement.TryGetProperty("modalities",out var modalities)||!modalities.TryGetProperty("vision",out var vision)||vision.ValueKind!=JsonValueKind.True)
                throw new InvalidOperationException("이 Gemma 서버는 이미지 입력이 꺼져 있습니다. 이미지 전용 서버 127.0.0.1:8092를 실행해 주세요.");
        }
        return new(actual,"Gemma 4 12B",context);
    }
    public async Task<SampleResult> GenerateAsync(ProblemDraft draft,string endpoint,IProgress<string>? progress=null,CancellationToken token=default,IReadOnlyList<VisualPage>? images=null)
    {
        draft.Validate();
        var plan=draft.SkipDeterministicPlan?null:ReactionVariantPlan.Create(draft);
        if (string.IsNullOrWhiteSpace(draft.Body)) throw new ArgumentException("파일의 글자를 먼저 로컬에서 읽어야 합니다. 인식된 본문을 확인하거나 문제를 직접 붙여 넣어 주세요.");
        var hasImages=images is{Count:>0};
        if(hasImages && (images!.Count>5||images.Sum(p=>(long)p.Bytes.Length)>FileImport.MaxBytes||images.Any(p=>p.Bytes.Length==0||p.MimeType is not("image/png" or "image/jpeg"))))throw new ArgumentException("원본 이미지의 형식·크기를 확인해 주세요.");
        progress?.Report(hasImages?"Gemma 4 12B 이미지 입력 지원 확인":"로컬 Gemma 4 12B 연결 확인"); var model=await ProbeAsync(endpoint,token,hasImages);
        if(draft.Source?.IsAttachment==true && images is not{Count:>0})throw new InvalidOperationException("원본 이미지를 준비하지 못했습니다. 파일을 다시 선택해 주세요.");
        var vision=new LocalVisionReader(client);var contexts=new List<VisualUnderstanding>();
        if(plan is null&&images is not null)foreach(var image in images){progress?.Report($"원본 {image.Page}페이지의 축·결합·연결 관계 확인");contexts.Add(await vision.UnderstandAsync(image,draft.Body,token));}
        var source=JsonSerializer.Serialize(new{inputFingerprint=draft.Fingerprint(),materialKind=draft.UseSolutionLogic?"problem-and-solution":draft.FromSolution?"solution":"problem",title=draft.Title,body=draft.Body,suppliedAnswer=draft.Answer,suppliedExplanation=draft.Explanation,suppliedSteps=draft.Steps,forbiddenLaterSteps=draft.ExcludedSteps,logicScope=draft.LogicScope,
            visualContext=contexts.ToArray(),verifiedPlan=plan is null?null:new{body=plan.Body,choices=plan.Choices,answer=plan.Answer,explanation=string.Join("\n",plan.Solution.Steps)},visualPolicy="원본 문제의 수치, 좌표, 조건을 변형한다. verifiedPlan이 있으면 그 조건·표·질문·보기·정답을 그대로 사용하고 미지수나 몰질량을 바꾸지 않는다. 수치의 성립은 앱이 계산한다. 필수 그림은 변경된 조건에 맞춰 작성한다."},new JsonSerializerOptions{Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping});
        object content=source;
        if(hasImages){var parts=new List<object>{new{type="text",text=source}};parts.AddRange(images!.Select(p=>(object)new{type="image_url",image_url=new{url=p.DataUrl}}));content=parts.ToArray();}
        SampleResult? result=null;
        for(var attempt=0;attempt<2;attempt++){
            var compact=attempt==0
                ?"\n[상세 해설 완성 규칙]\n1. 본문(body)에는 변형 문제와 필수 조건만 적는다.\n2. 해설(explanation)은 각 STEP마다 사용 조건, 판단 이유, 수치 대입 전 식, 실제 계산, 단위, 중간 결론과 최종 정답 연결을 자세히 적는다.\n3. steps는 상세 해설을 복사하지 말고 각 단계의 목표·핵심 판단·결론만 1~2문장으로 요약한다."
                :"\n이전 응답은 출력 한도를 넘었다. 같은 입력으로 완결된 JSON만 다시 작성한다. 본문 조건은 유지한다. 해설은 각 STEP의 조건·식·계산·결론을 최소 1문장씩 포함한다. steps는 기준 단계와 1:1로 유지하되 상세 해설을 반복하지 않고 핵심만 1~2문장으로 요약한다.";
            var body=new{model=model.Id,messages=new object[]{new{role="system",content=VariantResponse.LocalPrompt()+compact+"\n"+(draft.SkipDeterministicPlan?LearningStagePlan.GenerationRules+"\n":"")+ScientificVisuals.DrawingInstructions+"\n"+ScientificTemplates.Instructions},new{role="user",content}},
                max_tokens=attempt==0?6144:4096,temperature=0.0,stream=false,reasoning_effort="low",chat_template_kwargs=new{enable_thinking=false},response_format=new{type="json_object",schema=VariantResponse.LocalSchema(draft)}};
            progress?.Report(attempt==0?(hasImages?"Gemma가 원본 이미지를 직접 보며 변형 문제 작성 중 (약 1분 소요)":"로컬 Gemma가 변형 문제·정답·해설 작성 중 (로컬 GPU 생성 · 약 1분 소요)"):"Gemma 출력 한도 도달 · 간결한 완성 답변으로 자동 재시도 1/1 · 원본 유지");
            using var request=new HttpRequestMessage(HttpMethod.Post,new Uri(Endpoint(endpoint),"chat/completions")){Content=JsonContent.Create(body)};
            using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,token);
            if(!response.IsSuccessStatusCode)throw new InvalidOperationException($"로컬 Gemma 생성 요청 실패 ({(int)response.StatusCode}) · 입력은 유지됩니다.");
            var bytes=await FileImport.ReadLimitedAsync(await response.Content.ReadAsStreamAsync(token),1024*1024,token);
            if(attempt==0&&LengthLimited(bytes))continue;
            progress?.Report("응답 형식·원문 연결 확인");result=ParseResponse(bytes,draft,model.Name,requireFingerprint:true) with {RuntimeModelId=model.Id,ImageInputCount=images?.Count??0};if(plan is not null)result=plan.Apply(result);ScientificVisuals.RequireVisuals(result,ScientificVisuals.NeedsVisuals(draft.Body));
            break;
        }
        if(result is null)throw new InvalidDataException("Gemma 답변을 완성하지 못했습니다. 원본과 입력은 유지됩니다.");
        if(plan is null&&ReactionMassCheck.Solve(result.Body) is not null){progress?.Report("생성된 문항의 지원 수식 독립 검산");result=ReactionMassCheck.Verify(result);}
        if(plan is null&&images is not null && images.Count>0){
            for(var i=0;i<images.Count;i++){progress?.Report($"변형 문제를 원본 {images[i].Page}페이지와 시각 대조");await vision.VerifyAsync(images[i],contexts[i],result,token);}
            result=result with{VisualContexts=contexts.ToArray(),VisualVerification=$"Gemma 4 12B에 원본 이미지 {images.Count}장 직접 입력 · Qwen3-VL 원본 대조 · AI 확인이며 교사 검수 필요",
                Figures=images.Select((p,i)=>(p,i)).Where(x=>contexts[x.i].Kind is "graph" or "molecule" or "diagram").Select(x=>new PreservedFigure(x.p.Page,x.p.DataUrl,"기준 그림 · 연결 관계 유지 (원본 시각 자료, 새 수치 조건은 변형 본문 참조)")).ToArray()};
        }
        if(plan is not null)result=plan.Apply(result);
        return result;
    }
    private static bool LengthLimited(byte[] bytes)
    {
        try{using var json=JsonDocument.Parse(bytes);return json.RootElement.GetProperty("choices")[0].GetProperty("finish_reason").GetString()=="length";}
        catch(Exception e)when(e is JsonException or KeyNotFoundException or InvalidOperationException or IndexOutOfRangeException){return false;}
    }
    public static SampleResult ParseResponse(byte[] bytes,ProblemDraft draft,string model="Gemma 4 12B",bool requireFingerprint=false)
    {
        try
        {
            using var json=JsonDocument.Parse(bytes); var root=json.RootElement; var choice=root.GetProperty("choices")[0];
            if (choice.GetProperty("finish_reason").GetString()!="stop") throw new InvalidDataException("Gemma 답변이 출력 한도에 도달해 완료되지 않았습니다. 잘린 결과는 표시하지 않으며 원본과 입력은 유지됩니다.");
            var text=choice.GetProperty("message").GetProperty("content").GetString()??"";
            var variant=System.Text.Json.Nodes.JsonNode.Parse(text)!.AsObject();
            if(requireFingerprint){
                if(variant["inputFingerprint"]?.GetValue<string>()!=draft.Fingerprint())throw new InvalidDataException("생성 결과가 현재 입력 자료와 맞지 않습니다. 다시 생성해 주세요.");
                variant["sourceProblem"]=variant["status"]?.GetValue<string>()=="ready"?draft.Body:"";
                if(string.IsNullOrWhiteSpace(variant["sourceLocation"]?.GetValue<string>()))variant["sourceLocation"]=draft.FromSolution?"사용자 풀이 자료":"사용자 기준 문제";
            }
            if(variant["status"]?.GetValue<string>()=="ready")
            {
                var answerText=variant["answerText"]?.GetValue<string>()?.Trim();
                var choices=variant["choices"]!.AsArray().Select(c=>c?.GetValue<string>()?.Trim()).ToArray();
                var matches=choices.Select((c,i)=>(c,i)).Where(x=>!string.IsNullOrWhiteSpace(answerText)&&x.c==answerText).ToArray();
                if(matches.Length!=1)throw new InvalidDataException("계산한 정답과 보기가 일치하지 않습니다. 다시 생성해 주세요.");
                variant["answerIndex"]=matches[0].i;
            }
            var problemGraph=ScientificVisuals.ParseGraph(variant["graph"]);
            var diagrams=ScientificVisuals.ParseDiagrams(variant["diagrams"]);
            var drawings=ScientificVisuals.ParseDrawings(variant["drawings"]);
            var templates=ScientificTemplates.Parse(variant["visualTemplates"]);
            drawings=[..drawings,..templates.Select(ScientificTemplates.Compile)];
            var usage=root.TryGetProperty("usage",out var u)&&u.TryGetProperty("total_tokens",out var total)?$"총 {total} 토큰 · 로컬 실행 · API 비용 없음":"로컬 실행 · API 비용 없음";
            var result=VariantResponse.Parse(variant.ToJsonString(),draft,model,usage,requireTextMatch:true);
            return result with{GenerationNotice="로컬 Gemma AI 초안 · 독립 검산·교사 확인 전", Graph=problemGraph,Diagrams=diagrams,Drawings=drawings,VisualTemplates=templates,RuntimeModelId=model,RequiresVisuals=variant["visualRequirement"]?.GetValue<string>()=="required"};
        }
        catch(Exception e) when(e is JsonException or KeyNotFoundException or InvalidOperationException or IndexOutOfRangeException)
        { throw new InvalidDataException("로컬 모델 응답 형식이 올바르지 않습니다. 다시 생성해 주세요.",e); }
    }
}
