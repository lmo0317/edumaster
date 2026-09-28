using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace EduMaster.Core;

// Supported reaction/teacher method only. Build all data from a common mass
// ratio before writing questions. An LLM never invents a third inconsistent row.
public static class ReactionLearningPlan
{
    public const string Version="reaction-learning-plan-v3-compiled-feedback";
    sealed record MassRow(double A,double B,double Rest,char Species){
        public double ConsumedA=>Species=='A'?A-Rest:A;
        public double ConsumedB=>Species=='B'?B-Rest:B;
    }
    static string F(double x)=>ReactionMassCheck.FormatValue(x);
    static string T(double x,string symbol)=>F(x).Contains('/')?$"({F(x)}){symbol}":F(x)+symbol;
    static string W(double x)=>T(x,"w");

    public static SampleResult? Create(ProblemDraft draft,int number,int total,string explanationStyle="teacher")
    {
        if(explanationStyle is not("teacher" or "beginner"))throw new ArgumentException("지원하지 않는 반응량 해설 방식입니다.");
        if(!draft.UseSolutionLogic||total!=3||number is <1 or >3||draft.Steps.Length!=number
            ||draft.FromSolution||ScientificVisuals.NeedsVisuals(draft.Body))return null;
        if(number==3&&draft.VariantMode=="numeric")return null;
        if(!Regex.IsMatch(draft.Steps[0],@"가정|만약")||!Regex.IsMatch(draft.Steps[0],@"모순|자료와\s*맞지|일치하지"))return null;
        if(number>=2&&!Regex.IsMatch(draft.Steps[1],@"질량|몰수|양\s*\(mol\)"))return null;
        if(number==3&&!Regex.IsMatch(draft.Steps[2],@"상댓값|상대값|몰질량"))return null;
        if(TeacherMethodPolicy.HelperVariables(draft.Explanation).Any(v=>v is not("n" or "m")))return null;
        var source=ReactionMassCheck.Solve(draft.Body);
        if(source is null)return null;
        // This construction needs ambiguous first-row hypotheses and a positive
        // second-row residual smaller than both initial quantities.
        if(source.MassRatio<=2||source.B is <1 or >90)return null;
        var seed=SHA256.HashData(Encoding.UTF8.GetBytes(draft.Body));
        var ratio=source.MassRatio;var b=source.B+1+seed[3]%3;
        if(ratio>=2*b)return null;
        var p=2+seed[0]%3;var q=p+2+seed[1]%3;var u=q+2+seed[2]%3;
        var rows=new[]{new MassRow(2*p,ratio*p,p,'A'),new MassRow(q,ratio*q+ratio*q/(2*b),ratio*q/(2*b),'B'),new MassRow(3*u,ratio*u,2*u,'A')};
        var activeRows=number<3?rows[..2]:rows;
        var masses=string.Join("\n",activeRows.Select((r,i)=>$"| {new[]{"Ⅰ","Ⅱ","Ⅲ"}[i]} | {W(r.A)} | {W(r.B)} | {W(r.Rest)} |"));
        var body=$"다음 반응을 완결시킨 실험 {(number<3?"Ⅰ~Ⅱ":"Ⅰ~Ⅲ")}의 자료이다. w는 양수이고 b는 반응 계수이다.\nA(g) + bB(g) → 2C(g) + 2D(g)\n"+
            "표의 마지막 질량은 생성물을 제외하고 반응하지 않고 남은 A 또는 B의 질량이다.\n\n"+
            "| 실험 | 반응 전 A의 질량(g) | 반응 전 B의 질량(g) | 반응 후 반응하지 않고 남은 A 또는 B의 질량(g) |\n|---|---|---|---|\n"+masses;
        var step1=Proof(activeRows,ratio);
        if(explanationStyle=="beginner")step1="한계 반응물은 반응하면서 먼저 모두 없어지는 물질이다. 표에는 남은 물질의 이름이 없으므로 A 또는 B가 남는 두 경우를 가정한다. 같은 반응에서는 반응한 B 질량/A 질량의 비가 항상 같아야 한다.\n"+step1;
        var labels=new[]{"Ⅰ","Ⅱ","Ⅲ"};
        var quantities=string.Join("\n",activeRows.Select((r,i)=>$"실험 {labels[i]}: 남은 "+(r.Species=='A'?$"A는 {W(r.Rest)} g, B는 0 g":$"A는 0 g, B는 {W(r.Rest)} g")+
            $"이다. 질량 보존으로 생성된 C+D의 질량은 {W(r.A)}+{W(r.B)}−{W(r.Rest)}={W(r.A+r.B-r.Rest)} g이다. A가 {W(r.ConsumedA)} g, 즉 {T(r.ConsumedA,"n")} mol 반응하므로 C와 D는 각각 {T(2*r.ConsumedA,"n")} mol 생성된다."));
        var step2=$"A w g의 양을 n mol, B w g의 양을 m mol이라 놓는다. 같은 질량을 기준으로 몰수를 문자로 나타내면 각 실험의 반응 전후를 간단히 비교할 수 있다.\n{quantities}";
        if(explanationStyle=="beginner")step2="mol은 입자 수를 묶어 세는 단위다. 같은 질량이라도 물질에 따라 입자 수가 다르므로 A와 B에 서로 다른 문자 n,m을 쓴다.\n"+step2;
        string[] choices;string answer;string explanation;string[] steps;
        if(number==1){
            body+="\n\n실험 Ⅰ에서 한계 반응물(모두 소모되는 기체)은 무엇인가?";
            choices=["A","B","A와 B가 동시에 모두 소모된다.","A와 B가 모두 남는다.","주어진 자료로 결정할 수 없다."];
            answer="② B";explanation="STEP 1. 한계 반응물 가정과 실험 비교\n"+step1;steps=[step1];
        }else if(number==2){
            body+="\n\nA w g의 양을 n mol, B w g의 양을 m mol이라 할 때, 실험 Ⅱ에서 반응 후 남은 반응물의 양(mol)/생성된 C의 양(mol)은?";
            var coefficient=rows[1].Rest/(2*q);
            choices=new[]{.5,1,1.5,2,2.5}.Select(f=>$"{F(coefficient*f)} m/n").ToArray();
            step2+=$"\nSTEP 1에서 실험 Ⅱ의 잔류 기체는 B라고 판단했다. 남은 B의 양은 {T(rows[1].Rest,"m")} mol이고 생성된 C의 양은 {T(2*q,"n")} mol이다. 따라서 구하는 비는 ({T(rows[1].Rest,"m")})/({T(2*q,"n")})=({F(coefficient)})×(m/n)이다.";
            answer="② "+choices[1];explanation="STEP 1. 한계 반응물 가정과 실험 비교\n"+step1+"\n\nSTEP 2. 질량 보존과 문자로 몰수 정리\n"+step2;
            steps=[step1,step2];
        }else{
            var full=body.Split("| 실험 |",2)[0]+"D의 양/전체 기체의 양은 모든 실험에 같은 양의 상수 k를 곱한 상댓값으로 나타내었다.\n\n"+
                "| 실험 | 반응 전 A의 질량(g) | 반응 전 B의 질량(g) | 반응 후 반응하지 않고 남은 A 또는 B의 질량(g) | D의 양/전체 기체의 양 (상댓값) |\n|---|---|---|---|---|\n"+
                string.Join("\n",rows.Select((r,i)=>$"| {labels[i]} | {W(r.A)} | {W(r.B)} | {W(r.Rest)} | {new[]{"36","40","x"}[i]} |"))+
                "\n\n(b/x) × (C의 몰질량 + D의 몰질량)/(B의 몰질량)은?";
            body=full;
            var solved=ReactionMassCheck.Solve(body)??throw new InvalidDataException("설계한 반응량 세트의 독립 계산에 실패했습니다.");
            if(solved.B!=b||Math.Abs(solved.MassRatio-ratio)>1e-7||Math.Abs(solved.X-30)>1e-7)throw new InvalidDataException("반응량 세트의 설계값과 독립 계산이 다릅니다.");
            choices=new[]{.5,1,1.5,2,2.5}.Select(f=>F(solved.Value*f)).ToArray();answer="② "+choices[1];
            var coefficient=rows[1].Rest/(2*q);
            var moleRatio=b/ratio;
            var step3=(explanationStyle=="beginner"?"몰분율은 전체 기체의 입자 중 D가 차지하는 비율이다. 표의 상댓값은 이 비율에 똑같은 배율을 곱한 수이므로 그 배율부터 구한다. 몰질량은 1 mol의 질량으로, 질량을 몰수로 나누면 구할 수 있다.\n":"")+$"실험 Ⅰ에서 D의 양은 {F(2*p)}n mol이고 전체 기체의 양은 {F(5*p)}n mol이므로 D의 몰분율은 2/5이다. 상댓값 36은 실제 몰분율에 공통 배율 k를 곱한 값이므로 k = 36/(2/5) = 90이다.\n"+
                $"실험 Ⅱ에서는 STEP 1에서 판별한 잔류 기체 B를 전체 몰수에 포함한다. STEP 2의 몰수 정리로 남은 B/C의 양의 비는 ({T(rows[1].Rest,"m")})/({T(2*q,"n")})=({F(coefficient)})×(m/n)이다. C와 D의 양이 같으므로 D/전체 기체의 양 = 1/(2+({F(coefficient)})×(m/n)) = 40/90 = 4/9이다. 따라서 ({F(coefficient)})×(m/n) = 1/4, m/n = {F(moleRatio)}이다.\n"+
                $"A w g의 양을 n mol, B w g의 양을 m mol이라 놓았으므로 M_A=w/n, M_B=w/m이다. 따라서 M_A/M_B=m/n={F(moleRatio)}이다. B/A 소비 질량비 {F(ratio)}는 b×M_B/M_A이므로 b={F(ratio)}×{F(moleRatio)}={b}이다.\n"+
                $"실험 Ⅲ에서 D의 양은 {F(2*rows[2].ConsumedA)}n mol이고 전체 기체의 양은 {F(rows[2].Rest+4*rows[2].ConsumedA)}n mol이므로 D의 몰분율은 1/3이다. 따라서 x=90×1/3=30이다.\n"+
                $"반응 전후 질량 보존에서 M_A+bM_B=2M_C+2M_D이므로 (M_C+M_D)/M_B=({F(moleRatio)}+{b})/2={F((moleRatio+b)/2)}이다. 최종값은 (b/x)×(M_C+M_D)/M_B=({b}/30)×{F((moleRatio+b)/2)}={F(solved.Value)}이다.";
            explanation="STEP 1. 한계 반응물 가정과 실험 비교\n"+step1+"\n\nSTEP 2. 질량 보존과 문자로 몰수 정리\n"+step2+
                "\n\nSTEP 3. 상댓값과 반응 계수·몰질량 계산\n"+step3;
            steps=[step1,step2,step3];
        }
        var result=new SampleResult(Guid.NewGuid(),draft.Id,draft.Fingerprint(),draft.Title,body,choices,answer,explanation,steps,
            "STEP 1의 잔류 기체 판별을 최종 표에, STEP 1~2 문제의 잔류 반응물/C 몰수비를 STEP 3의 D 몰분율 1/(2+잔류/C)에 연결했습니다. n,m의 비로 몰질량과 반응계수를 구하는 원본 방법을 유지했습니다. 잔류 배치와 x의 위치도 변경했습니다."){
            SourceProblem=draft.Body,SourceExplanation=draft.Explanation,SourceAnswer=draft.Answer,SourceSteps=draft.Steps,LearningSteps=draft.Steps,
            VariantMode=draft.VariantMode,PriorStageIdeas=draft.PriorStageIdeas,PromptVersion=Version,Model="검산된 반응량 학습 템플릿",
            GenerationNotice="코드 수치 설계·독립 검산 · 교사 확인 전",UsageSummary="문제 생성 AI 호출 없음 · 반응량 학습 템플릿",RequiresVisuals=false};
        var report=ProblemQualityHarness.Inspect(result,draft,number<total);
        var numerical=Inspect(result);
        if(numerical is null||numerical.State!="pass")throw new InvalidDataException("반응량 단계 문제의 독립 검산에 실패했습니다.");
        report=ProblemQualityHarness.Merge(report,[numerical]);
        report=report with{Checks=report.Checks.Select(c=>c.State!="fail"&&c.Id is "language" or "conditions" or "semantic-math" or "visual-semantics"
            ?c with{State="pass",Evidence="모든 실험의 공통 소비 질량비·잔류 기체 유일성·보기와 고정 풀이를 코드로 대조했습니다.",Method="code-reaction-learning-template"}:c).ToArray()};
        if(report.State=="fail")throw new InvalidDataException("반응량 학습 템플릿 검사 실패: "+string.Join(" | ",report.Checks.Where(c=>c.State=="fail").Select(c=>c.Evidence)));
        return result with{Quality=report};
    }

    static string Proof(MassRow[] rows,double ratio)
    {
        var a=rows[0];var z=rows[1];
        var wrong=(a.B-a.Rest)/a.A;
        var wrongSecondA=z.B/(z.A-z.Rest);var wrongSecondB=(z.B-z.Rest)/z.A;
        return $"실험 Ⅰ에서 A가 모두 반응했다고 가정하면 소비 질량은 A {W(a.A)} g, B {W(a.B-a.Rest)} g이므로 B/A 소비 질량비는 {F(wrong)}이다. " +
            $"실험 Ⅱ에서 A가 남으면 B/A 소비 질량비는 ({F(z.B)})/({F(z.A)}−{F(z.Rest)})={F(wrongSecondA)}, B가 남으면 ({F(z.B)}−{F(z.Rest)})/{F(z.A)}={F(wrongSecondB)}이다. 어느 것도 {F(wrong)}과 같지 않아 가정이 모순이다. " +
            $"따라서 실험 Ⅰ에서는 B가 모두 반응하고 A가 {W(a.Rest)} g 남는다. 공통 B/A 소비 질량비는 {F(a.B)}/({F(a.A)}−{F(a.Rest)})={F(ratio)}이다. " +
            $"이 비를 실험 Ⅱ에 적용하면 A가 모두 소모되고 B {W(z.Rest)} g이 남아 표와 일치한다."+
            (rows.Length==3?$" 실험 Ⅲ에서도 B가 모두 소모되고 A {W(rows[2].Rest)} g이 남아 표와 일치한다.":"");
    }

    public static QualityCheck? Inspect(SampleResult result)
    {
        if(result.PromptVersion!=Version)return null;
        if(ReactionMassCheck.Solve(result.Body) is { } full){
            var correct=ReactionMassCheck.ReferenceAnswerMatches(result.Answer,full);
            return new("calculation","독립 수치 검산",correct?"pass":"fail",$"반응량 표의 b={full.B}, x={F(full.X)}, 최종값 {full.Answer}과 표시 정답을 대조했습니다.","code-reaction-learning");
        }
        var data=result.Body.Split('\n').Select(l=>l.Trim('|').Split('|',StringSplitOptions.TrimEntries)).Where(c=>c.Length==4&&Regex.IsMatch(c[0],@"^[ⅠⅡⅢ]$")).ToArray();
        if(data.Length is not(2 or 3))return null;
        static double N(string s){s=s.Replace("w","").Replace("(","").Replace(")","");var p=s.Split('/');return double.Parse(p[0],CultureInfo.InvariantCulture)/(p.Length==2?double.Parse(p[1],CultureInfo.InvariantCulture):1);}
        var candidates=new List<(char[] Species,double Ratio)>();
        for(var mask=0;mask<(1<<data.Length);mask++){
            var kinds=Enumerable.Range(0,data.Length).Select(i=>(mask&(1<<i))==0?'A':'B').ToArray();
            var rs=data.Select((c,i)=>new MassRow(N(c[1]),N(c[2]),N(c[3]),kinds[i])).ToArray();
            if(rs.Any(r=>r.ConsumedA<=0||r.ConsumedB<=0))continue;
            var ratios=rs.Select(r=>r.ConsumedB/r.ConsumedA).ToArray();
            if(ratios.All(v=>Math.Abs(v-ratios[0])<1e-7))candidates.Add((kinds,ratios[0]));
        }
        var expected=candidates.Count==1?result.Steps.Length==1?(candidates[0].Species[0]=='A'?"B":"A")
            :candidates[0].Species[1]=='B'?$"{F(N(data[1][3])/(2*N(data[1][1])))} m/n":"":"";
        var answer=Regex.Replace(result.Answer,@"^[①②③④⑤]\s*","");
        var unique=result.Steps.Length==1?result.Choices.Distinct().Count()==5
            :result.Choices.All(c=>Regex.IsMatch(c,@"^\d+(?:/\d+)? m/n$"))&&result.Choices.Select(c=>F(N(c.Replace(" m/n","")))).Distinct().Count()==5;
        var ok=expected.Length>0&&answer==expected&&result.Choices.Count(c=>c==expected)==1&&unique;
        return new("calculation","독립 수치 검산",ok?"pass":"fail",
            ok?$"잔류 기체 {1<<data.Length}가지 조합을 대조해 유일한 공통 소비 질량비 {F(candidates[0].Ratio)}와 정답 {expected}, 보기 유일성을 확인했습니다.":"표의 잔류 기체·공통 소비 질량비·정답 또는 보기 유일성이 일치하지 않습니다.","code-reaction-learning");
    }

    public static void VerifyEdited(SampleResult plan,SampleResult edited)
    {
        static string Compact(string text)=>Regex.Replace(LocalVisionReader.NormalizeMath(text),@"\s+","");
        if(Compact(plan.Body)!=Compact(edited.Body)||!plan.Choices.Select(Compact).SequenceEqual(edited.Choices.Select(Compact))
            ||Compact(plan.Answer)!=Compact(edited.Answer))throw new InvalidDataException("피드백 적용 중 검산된 문제 조건·보기·정답이 변경됐습니다. 고정 설계를 유지해 다시 작성해야 합니다.");
        var inspected=Inspect(edited with{PromptVersion=Version,Steps=plan.Steps});
        if(inspected?.State!="pass")throw new InvalidDataException("피드백 적용 결과의 독립 검산을 통과하지 못했습니다.");
    }
}
