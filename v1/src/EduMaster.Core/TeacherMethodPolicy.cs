using System.Text.Json;
using System.Text.RegularExpressions;

namespace EduMaster.Core;

public static class TeacherMethodPolicy
{
    // Keep the actual worked calculations, rather than substituting STEP summaries.
    // If headings are unclear, retain the source as context; the explicit scope still
    // determines which operations are allowed in the exercise.
    public static string ScopedExplanation(ProblemDraft source, int stepCount)
    {
        if (stepCount >= source.Steps.Length) return source.Explanation;
        var headings = Regex.Matches(source.Explanation, @"(?im)(?:^|\n)\s*STEP\s*(?<n>[1-6])\s*[.·:：\-]?");
        var next = headings.Cast<Match>().FirstOrDefault(m => m.Groups["n"].Value == (stepCount + 1).ToString());
        return next is not null && headings.Cast<Match>().Any(m => m.Groups["n"].Value == "1")
            ? source.Explanation[..next.Index].Trim() : source.Explanation;
    }

    public static string[] HelperVariables(string explanation)
    {
        var text=LocalVisionReader.NormalizeMath(explanation);
        var quantities=Regex.Matches(text,@"양\s*\(\s*mol\s*\)\s*을\s*(?<v>[a-z])(?![A-Za-z])")
            .Cast<Match>().Select(m=>m.Groups["v"].Value);
        return Regex.Split(text, @"[\r\n]|(?<!\d)[.。]")
            .Where(line => Regex.IsMatch(line, @"이라|라고|으로\s*(?:놓|두|정)|로\s*(?:놓|두|정)"))
            .SelectMany(line => Regex.Matches(line, @"(?<![A-Za-z])(?<v>[a-z])\s*(?:mol|몰)(?![A-Za-z])")
                .Cast<Match>().Select(m => m.Groups["v"].Value))
            .Concat(quantities).Distinct().ToArray();
    }

    public static ProblemSolutionMaterial EnrichReadSteps(ProblemSolutionMaterial material)
    {
        var headings=Regex.Matches(material.Explanation,@"(?im)^\s*STEP\s*(?<n>[1-6])\s*[.·:：\-]?\s*");
        if(headings.Count!=material.Steps.Length)return material;
        var steps=new List<string>();
        for(var i=0;i<headings.Count;i++){
            if(headings[i].Groups["n"].Value!=(i+1).ToString())return material;
            var start=headings[i].Index+headings[i].Length;
            var end=i+1<headings.Count?headings[i+1].Index:material.Explanation.Length;
            var lines=material.Explanation[start..end].Split('\n',StringSplitOptions.RemoveEmptyEntries|StringSplitOptions.TrimEntries)
                .TakeWhile(line=>!Regex.IsMatch(line,@"^\[(?:보기|선택지)"))
                .Where(line=>!line.StartsWith('|'));
            var detail=string.Join(" ",lines);
            steps.Add(detail[..Math.Min(2800,detail.Length)]);
        }
        var body=material.Body;
        var notes=material.Uncertainties;
        if(Regex.IsMatch(steps[0],@"가정|만약")&&Regex.IsMatch(steps[0],@"모순|자료와\s*맞지|일치하지")
            &&ReactionMassCheck.Solve(body) is not null&&ReactionMassCheck.TryHideRemainingSpecies(body,out var withoutAnnotations,out _)){
            body=withoutAnnotations;
            notes=notes.Concat(["해설에서 추론하는 잔류 기체의 A/B 표시는 문제 조건에서 제외했습니다. 원본 이미지와 실제 풀이 순서는 그대로 보존합니다."]).Distinct().ToArray();
        }
        return material with{Body=body,Steps=steps.ToArray(),Uncertainties=notes};
    }

    public static object Contract(ProblemDraft draft) => new {
        referenceExplanation = draft.Explanation,
        allowedSteps = draft.Steps,
        forbiddenLaterSteps = draft.ExcludedSteps,
        helperVariables = draft.IsPartialLearningStage ? HelperVariables(string.Join("\n", draft.Steps)) : HelperVariables(draft.Explanation),
        firstRelativeCalculationStep = FirstRelativeStep(draft),
        stepContracts = Sections(draft.Explanation,draft.Steps).Select((text,i)=>new{number=i+1,reference=text,
            helpersIntroduced=HelperVariables(text),requiresCrossExperimentComparison=i==0&&RequiresCrossExperimentComparison(text)}),
        requirement = "기준 풀이의 문자 정의·치환·가정·비교·모순 판정과 순서를 보존한다. 숫자와 결론은 새 조건으로 계산한다."
    };

    // Text and allowed/forbidden steps are already sent in dedicated fields.
    // Do not multiply the same reference solution inside every review request.
    public static object CompactContract(ProblemDraft draft) => new {
        helperVariables=HelperVariables(draft.IsPartialLearningStage?string.Join("\n",draft.Steps):draft.Explanation),
        firstRelativeCalculationStep=FirstRelativeStep(draft),
        stepContracts=Sections(draft.Explanation,draft.Steps).Select((text,i)=>new{
            number=i+1,helpersIntroduced=HelperVariables(text),
            requiresCrossExperimentComparison=i==0&&RequiresCrossExperimentComparison(text)}),
        requirement="기준 풀이의 문자 정의·치환·가정·비교·모순 판정과 순서를 보존한다. 숫자와 결론은 새 조건으로 계산한다."
    };

    private static int? FirstRelativeStep(ProblemDraft draft)
    {
        var sections=Sections(draft.Explanation,draft.Steps);
        var index=Array.FindIndex(sections,s=>Regex.IsMatch(s,@"상댓값|상대값|몰분율"));
        return index<0?null:index+1;
    }

    private static string[] Sections(string explanation,string[] fallback)
    {
        var headings=Regex.Matches(explanation,@"(?im)^\s*STEP\s*[1-6]\s*[.·:：\-]?\s*");
        if(headings.Count!=fallback.Length)return fallback;
        return headings.Cast<Match>().Select((m,i)=>explanation[(m.Index+m.Length)..(i+1<headings.Count?headings[i+1].Index:explanation.Length)]).ToArray();
    }

    public static bool RequiresCrossExperimentComparison(string firstStep)
    {
        var assumption=Regex.Match(firstStep,@"만약|가정(?:하|했|한다)");
        if(!assumption.Success)return false;
        var start=Math.Max(0,assumption.Index-70);
        var counter=Regex.Match(firstStep[assumption.Index..],@"모순|불가능|자료와\s*맞지|일치하지|성립하지");
        if(!counter.Success)return false;
        var caseText=firstStep[start..(assumption.Index+counter.Index)];
        return Regex.Matches(caseText,@"(?<![A-Za-z])(?:Ⅲ|Ⅱ|Ⅰ|III|II|I)(?![A-Za-z])")
            .Select(m=>m.Value.Replace("Ⅰ","I").Replace("Ⅱ","II").Replace("Ⅲ","III")).Distinct().Count()>=2;
    }

    public static QualityCheck? InspectOrder(ProblemDraft draft,SampleResult result)
    {
        if(!draft.UseSolutionLogic||draft.Steps.Length!=result.Steps.Length)return null;
        var source=Sections(draft.Explanation,draft.Steps);
        var generated=Sections(result.Explanation,result.Steps).Select((s,i)=>s+"\n"+result.Steps[i]).ToArray();
        foreach(var helper in HelperVariables(draft.Explanation)){
            var pattern=$@"(?<![A-Za-z_]){Regex.Escape(helper)}(?![A-Za-z_])";
            var expected=Array.FindIndex(source,s=>Regex.IsMatch(s,pattern));
            var actual=Array.FindIndex(generated,s=>Regex.IsMatch(s,pattern));
            if(actual>=0&&expected>=0&&actual<expected)return new("source-method-order","원본 STEP별 풀이 순서","fail",
                $"원본은 {helper}를 STEP {expected+1}에서 도입하지만 생성 풀이가 STEP {actual+1}에서 먼저 사용합니다. 같은 STEP에 문자 도입과 계산을 배치해 주세요.","code-teacher-method");
        }
        var relative=@"상댓값|상대값|몰분율";
        var referenceRelative=Array.FindIndex(source,s=>Regex.IsMatch(s,relative));
        var generatedRelative=Array.FindIndex(generated,s=>Regex.IsMatch(s,relative));
        if(referenceRelative>=0&&generatedRelative>=0&&generatedRelative<referenceRelative)return new("source-method-order","원본 STEP별 풀이 순서","fail",
            $"원본 STEP {referenceRelative+1}의 상댓값·몰분율 풀이를 생성 STEP {generatedRelative+1}로 앞당겼습니다. 원본의 단계별 판단과 계산 범위를 유지해 주세요.","code-teacher-method");
        return null;
    }

    public static ProblemDraft? RestoreReference(SampleResult result,bool partial)
    {
        if(result.SourceSteps.Length==0||string.IsNullOrWhiteSpace(result.SourceExplanation))return null;
        var source=new ProblemDraft{Title=result.Title,Body=result.SourceProblem,Answer=result.SourceAnswer,
            Explanation=result.SourceExplanation,Steps=result.SourceSteps,UseSolutionLogic=true,
            VariantMode=result.VariantMode is "numeric" or "integrated"?result.VariantMode:result.PromptVersion==ReactionVariantPlan.Version?"numeric":"integrated",
            PriorStageIdeas=result.PriorStageIdeas};
        var allowed=result.LearningSteps.Length>0?result.LearningSteps:result.SourceSteps;
        return source with{Steps=allowed,ExcludedSteps=partial?result.SourceSteps.Skip(allowed.Length).ToArray():[],
            Explanation=partial?ScopedExplanation(source,allowed.Length):source.Explanation,IsPartialLearningStage=partial};
    }

    public static QualityCheck? Inspect(ProblemDraft draft, SampleResult result)
    {
        if (!draft.UseSolutionLogic) return null;
        var helpers = HelperVariables(draft.IsPartialLearningStage ? string.Join("\n", draft.Steps) : draft.Explanation);
        if (helpers.Length == 0) return null;
        var text = LocalVisionReader.NormalizeMath(result.Explanation + "\n" + string.Join("\n", result.Steps));
        var missing = helpers.Where(v => !Regex.IsMatch(text, $@"(?<![A-Za-z_]){Regex.Escape(v)}(?![A-Za-z_])")).ToArray();
        return new("source-method", "원본 풀이의 보조 문자", missing.Length == 0 ? "pass" : "fail",
            missing.Length == 0 ? "원본에서 명시적으로 정의한 보조 문자를 유지했습니다. 정의와 계산 의미는 별도 AI 검토에서 대조합니다."
                : $"원본 풀이에서 정의한 {string.Join(", ", missing)}가 사라졌습니다. 같은 문자 정의와 계산 방법을 새 수치로 적용해 주세요.", "code-teacher-method");
    }

    public static string PriorIdeas(IEnumerable<(string Label, SampleResult Result)> earlier)
    {
        string Clip(string value, int count) => value[..Math.Min(value.Length, count)];
        var items = earlier.Select(x => new {
            stage = x.Label,
            conditionData = Clip(x.Result.Body, 750),
            question = x.Result.Body.Length <= 750 ? "" : x.Result.Body[^Math.Min(350, x.Result.Body.Length)..],
            actualSolutionSteps = x.Result.Steps.Select(s => Clip(s, 220)).ToArray(),
            designIdea = Clip(x.Result.ChangeSummary, 200)
        }).ToArray();
        // Reduce complete records instead of truncating a JSON string halfway.
        for (var count = items.Length; count > 0; count--) {
            var json = JsonSerializer.Serialize(items.Take(count), new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
            if (json.Length <= 5000) return json;
        }
        return "";
    }
}
